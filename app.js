import { preloadAllSymbols, getSymbol, getAllSymbolNames } from './src/symbolLoader.js';
import { addSymbolLayerToMap, drawVoronoiLayers, addEmptyPointsLayer } from './src/drawingUtils.js';
import { borderStyles, areaFillStyles } from './src/styleConfig.js';


////////////////////////////////////////////// Initial load of all data and layout setup //////////////////////////////////////////////////

let map;
let metadata;
let editing_mode = false;

async function init() {
  await preloadAllSymbols();
  /**************************** Define map layer ****************************/
  map = L.map("map").setView([54.0, 18.0], 8.2);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  /*********************** Load map boundaries from GeoJSON ***********************/
  let clippingGeometry;

  try {
    const geojson = await fetch('data/map_boundaries.geojson').then(res => res.json());
    clippingGeometry = geojson.features[0];

    L.geoJSON(clippingGeometry, {
      style: {
        color: "green",
        weight: 2,
        fill: false
      }
    }).addTo(map);
  } catch (err) {
    console.error("Failed to load map boundaries:", err);
  }

  /**************************** Load Atlas data ****************************/
  const [pointsRawText, dataRawText, metadataRaw] = await Promise.all([
    fetch("data/points.csv").then(res => res.text()),
    fetch("data/data.csv").then(res => res.text()),
    fetch(`data/metadata.json?nocache=${Date.now()}`).then(res => res.json())
  ]);

  const points = d3.dsvFormat(";").parse(pointsRawText);
  const data = d3.dsvFormat(";").parse(dataRawText);
  metadata = metadataRaw;

  // Make points and data available globally if needed
  window.clippingGeometry = clippingGeometry;
  window.points = points;
  window.data = data;

  /**************************** Add Legend Box ****************************/
  const legendControl = L.control({ position: "topright" });

  legendControl.onAdd = function (map) {
    const div = L.DomUtil.create("div", "legend-container");
    div.id = "legend";
    return div;
  };

  legendControl.addTo(map);

  /**************************** Render UI ****************************/
  renderSidebar();
}

/**************************** Function for map cleaning ****************************/
function cleanMap() {

  // Clean Legend
  const container = document.querySelector('.legend-container');
  container.innerHTML = "";

  // Clean Map
  if (symbolLayer) map.removeLayer(symbolLayer);
  if (voronoiLayers) {
    for (const layerId in voronoiLayers) {
      const layerGroup = voronoiLayers[layerId];

      // Remove border layers if present
      if (layerGroup.borders) {
        layerGroup.borders.forEach(layer => map.removeLayer(layer));
      }

      // Remove area fill layers if present
      if (layerGroup.areaFills) {
        layerGroup.areaFills.forEach(layer => map.removeLayer(layer));
      }
    }
  }
}

// Function for cleaning up the editing environment
function cleanEditingEnv() {
  document.getElementById("right-sidebar")?.remove(); // remove the right sidebar
  document.querySelectorAll(".layer-box").forEach(b => { // color the background of all the layers to neutral
    b.style.backgroundColor = "";
  });
  map.removeLayer(symbolLayer); // remove the points from the map

  // Remove existing drawControl if it exists
  if (map._drawControl) {
    map.removeControl(map._drawControl);
  }
}

/**************************** Function for GeoJSON creation for plotting ****************************/

/**
 * Generates a GeoJSON-like array of point features for map plotting.
 * Each feature includes location, place name, and styling info (symbols, borders, fills)
 * based on the provided legend list and matched data.
 *
 * @param {Array} legendList - Optional array of layer definitions with styling (symbol, border, area_fill).
 * @returns {Array} Array of GeoJSON-style Feature objects.
 */
function loadFeatures(mapId = "", legendList = []) {
  const features = [];

  // Index the data rows from data/data.csv by point_id for fast lookup
  const dataByPointId = Object.fromEntries(
    data.map(row => [row.point_id, row])
  );

  // Process each point
  for (const point of points) {
    const [latStr, lonStr] = point.Coordinates.split(",");
    const lat = Number(latStr.trim());
    const lon = Number(lonStr.trim());

    const activeSymbols = [];
    const activeBorderGroups = [];
    const activeAreaFillGroups = [];

    // Look up corresponding data row
    const dataRow = dataByPointId[point.point_id];
    if (!dataRow) continue; // skip if no data

    for (const layer of legendList) {
      const colKey = `${mapId}/${layer.layer_id}`;
      const cellValue = dataRow[colKey];

      if (
        cellValue === undefined || 
        cellValue === null || 
        cellValue === "0" || 
        cellValue === 0 || 
        (typeof cellValue === "string" && cellValue.trim() === "")
      ) continue;

      if (layer.symbol) {
        activeSymbols.push({ name: layer.name, symbol: layer.symbol });
      }

      if (layer.border) {
        activeBorderGroups.push(layer.layer_id);
      }

      if (layer.area_fill) {
        activeAreaFillGroups.push(layer.layer_id);
      }
    }

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: point.point_id,
        place_name: point["City Name Today"] && point["City Name Today"].trim() !== "" 
          ? point["City Name Today"] 
          : point["Original City Name"],
        activeSymbols,
        activeBorderGroups,
        activeAreaFillGroups
      }
    });
  }
  return features;
}

////////////////////////////////////////////////////// Logic for sidebar rendering //////////////////////////////////////////////////////////////

function renderSidebar() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = ""; // Clear existing content

  if (editing_mode) {
    // Master data structure for CSV export
    const layerCsvData = points.map(p => ({
      point_id: p.point_id  // Copy just the point_id from the original points
    }));
    // Master metadata dict
    let mapMetadata = {"layers": []}

    function saveEditedLayer(layerMetadata, selectedIds) {
      // Remove any existing layer with the same layer_id
      mapMetadata["layers"] = mapMetadata["layers"].filter(
        layer => layer.layer_id !== layerMetadata.layer_id
      );

      // Add the new (edited) layer metadata
      mapMetadata["layers"].push(layerMetadata);

      // Fill this column: 1 if selected, 0 if not
      for (const row of layerCsvData) {
        row[layerMetadata["layer_id"]] = selectedIds.includes(row.point_id) ? 1 : 0;
      }
    }

    function getSelectedPointIds(selectedColumn) {
      return layerCsvData
        .filter(row => row[selectedColumn] === 1)
        .map(row => row.point_id);
    }

    function removeLayer(layerId) {
      // Remove the layer from mapMetadata.layers
      mapMetadata["layers"] = mapMetadata["layers"].filter(layer => layer.layer_id !== layerId);

      // Remove the column from each row in layerCsvData
      for (const row of layerCsvData) {
        delete row[layerId];
      }
    }

    // Holder for the next layer id that should be taken
    let smallestFreeLayerId = 0

    // BACK BUTTON
    const backBtn = document.createElement("button");
    backBtn.textContent = "← Powrót";
    backBtn.style.marginBottom = "10px";
    backBtn.id = "back-button";
    backBtn.onclick = () => {
      editing_mode = false;
      renderSidebar(); // Re-render normal view
      document.getElementById("right-sidebar")?.remove(); // Remove right sidebar if open
    };
    sidebar.appendChild(backBtn);

    // === Map metadata inputs ===

    // ID mapy (Map ID) text input box
    const idLabel = document.createElement("label");
    idLabel.textContent = "ID mapy";
    idLabel.style.marginTop = "10px";
    sidebar.appendChild(idLabel);

    const idInput = document.createElement("input");
    idInput.type = "text";
    idInput.id = "map-id-input";
    idInput.placeholder = "np. XV.1";
    idInput.style.marginBottom = "8px";
    idInput.style.width = "100%";
    sidebar.appendChild(idInput);

    // Nazwa mapy (Map name) text input box
    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Nazwa mapy";
    sidebar.appendChild(nameLabel);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = "map-name-input";
    nameInput.placeholder = "np. Granice dialektów na obszarze AJK";
    nameInput.style.marginBottom = "8px";
    nameInput.style.width = "100%";
    sidebar.appendChild(nameInput);

    // Autor (Author) text input box
    const authorLabel = document.createElement("label");
    authorLabel.textContent = "Autor";
    sidebar.appendChild(authorLabel);

    const authorInput = document.createElement("input");
    authorInput.type = "text";
    authorInput.id = "map-author-input";
    authorInput.placeholder = "np. Jan Kowalski";
    authorInput.style.marginBottom = "12px";
    authorInput.style.width = "100%";
    sidebar.appendChild(authorInput);

    // HEADING + ADD BUTTON
    const headingWrapper = document.createElement("div");
    headingWrapper.style.display = "flex";
    headingWrapper.style.justifyContent = "space-between";
    headingWrapper.style.alignItems = "center";

    const heading = document.createElement("strong");
    heading.textContent = "Istniejące warstwy";

    const addBtn = document.createElement("span");
    addBtn.textContent = "+";
    addBtn.title = "Dodaj nową warstwę";
    addBtn.style.cursor = "pointer";
    addBtn.style.marginLeft = "10px";
    addBtn.style.fontSize = "16px";
    addBtn.style.userSelect = "none";
    addBtn.style.padding = "2px 6px";
    addBtn.style.border = "1px solid #ccc";
    addBtn.style.borderRadius = "4px";
    addBtn.style.backgroundColor = "#eee";
    addBtn.style.color = "#333";
    addBtn.style.boxShadow = "1px 1px 2px rgba(0,0,0,0.1)";
    addBtn.style.transition = "background-color 0.2s";

    addBtn.onmouseover = () => {
      addBtn.style.backgroundColor = "#ddd";
    };
    addBtn.onmouseout = () => {
      addBtn.style.backgroundColor = "#eee";
    };

    addBtn.onclick = () => {
      const layerList = document.getElementById("layer-list");

      const layerId = smallestFreeLayerId++; // assign and increment
      const layerName = `Warstwa ${layerId}`;

      const box = document.createElement("div");
      box.className = "layer-box";
      box.style.display = "flex";
      box.style.alignItems = "center";
      box.style.justifyContent = "space-between";
      box.style.padding = "6px 10px";
      box.style.margin = "6px 0";
      box.style.borderRadius = "4px";
      box.style.backgroundColor = "";
      box.style.border = "1px solid black";
      box.id = `layer-box-${layerId}`;
      box._layerId = layerId;

      const label = document.createElement("span");
      label.textContent = layerName;
      label.style.flex = "1";

      // Pen icon (Edit)
      const editIcon = document.createElement("span");
      editIcon.innerHTML = "✎";
      editIcon.title = "Edytuj";
      editIcon.style.cursor = "pointer";
      editIcon.style.marginLeft = "8px";

      editIcon.onclick = () => {
        let layerMetadata = mapMetadata.layers.find(layer => layer.layer_id === layerId);
        if (!layerMetadata) {
          layerMetadata = {"layer_id": layerId};
        }
        const preselectedPoints = getSelectedPointIds(layerId);
        layerRightSidebar(saveEditedLayer, layerMetadata, preselectedPoints);
        // Optional: visually mark this box as active
        document.querySelectorAll(".layer-box").forEach(b => {
          b.style.backgroundColor = ""; // reset
        });
        box.style.backgroundColor = "#f8d7da"; // mark as active
      };

      // X icon (Delete)
      const deleteIcon = document.createElement("span");
      deleteIcon.innerHTML = "✕";
      deleteIcon.title = "Usuń";
      deleteIcon.style.cursor = "pointer";
      deleteIcon.style.marginLeft = "8px";

      deleteIcon.onclick = () => {
        box.remove();
        removeLayer(layerId);
        cleanEditingEnv();
      };

      const controls = document.createElement("div");
      controls.style.display = "flex";
      controls.appendChild(editIcon);
      controls.appendChild(deleteIcon);

      box.appendChild(label);
      box.appendChild(controls);

      layerList.appendChild(box);
    };

    headingWrapper.appendChild(heading);
    headingWrapper.appendChild(addBtn);
    sidebar.appendChild(headingWrapper);

    // LAYER LIST
    const layerList = document.createElement("ul");
    layerList.id = "layer-list"; // Empty initially
    sidebar.appendChild(layerList);

    // DOWNLOAD BUTTON
    const downloadBtn = document.createElement("button");
    downloadBtn.textContent = "Pobierz gotową mapę";
    downloadBtn.style.backgroundColor = "#007bff";
    downloadBtn.style.color = "white";
    downloadBtn.style.border = "none";
    downloadBtn.style.marginTop = "auto";
    downloadBtn.id = "download-map-button";
    sidebar.appendChild(downloadBtn);

    downloadBtn.addEventListener("click", () => {
      // 1. Expand mapMetadata
      mapMetadata["map_id"] = idInput.value;
      mapMetadata["map_name"] = nameInput.value;
      mapMetadata["author"] = authorInput.value;

      const mapId = mapMetadata["map_id"];

      // 2. Prepare headers
      const originalHeaders = Object.keys(layerCsvData[0]);
      const renamedHeaders = originalHeaders.map(col =>
        col === "point_id" ? "point_id" : `${mapId}/${col}`
      );

      // 3. Transform data with renamed keys
      const renamedCsvData = layerCsvData.map(row => {
        const renamedRow = {};
        for (const key of originalHeaders) {
          const newKey = key === "point_id" ? "point_id" : `${mapId}/${key}`;
          renamedRow[newKey] = row[key];
        }
        return renamedRow;
      });

      // 4. Convert to semicolon-separated CSV
      const csvRows = renamedCsvData.map(row =>
        renamedHeaders.map(header => JSON.stringify(row[header] ?? "")).join(";")
      );
      const csvContent = [renamedHeaders.join(";"), ...csvRows].join("\n");

      const csvBlob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const csvUrl = URL.createObjectURL(csvBlob);
      const csvLink = document.createElement("a");
      csvLink.href = csvUrl;
      csvLink.download = "mapa_dane.csv";
      csvLink.click();
      URL.revokeObjectURL(csvUrl);

      // 5. Download mapMetadata as JSON
      const jsonBlob = new Blob([JSON.stringify(mapMetadata, null, 2)], { type: "application/json" });
      const jsonUrl = URL.createObjectURL(jsonBlob);
      const jsonLink = document.createElement("a");
      jsonLink.href = jsonUrl;
      jsonLink.download = "mapa_metadata.json";
      jsonLink.click();
      URL.revokeObjectURL(jsonUrl);
    });

    cleanMap(); // Clear map for editing mode
  } else {
    // Normal (viewing) mode UI
    const labelSelect = document.createElement("label");
    labelSelect.setAttribute("for", "map-select");
    labelSelect.id = "map-label";
    labelSelect.textContent = "Wybierz mapę:";
    sidebar.appendChild(labelSelect);

    const select = document.createElement("select");
    select.id = "map-select";
    sidebar.appendChild(select);

    const labelAuthor = document.createElement("label");
    labelAuthor.setAttribute("for", "map-author");
    labelAuthor.id = "author-label";
    labelAuthor.textContent = "Autor:";
    sidebar.appendChild(labelAuthor);

    const authorBox = document.createElement("div");
    authorBox.id = "map-author";
    sidebar.appendChild(authorBox);

    const loadMapBtn = document.createElement("button");
    loadMapBtn.id = "load-map-button";
    loadMapBtn.textContent = "Załaduj mapę";
    sidebar.appendChild(loadMapBtn);

    const newMapBtn = document.createElement("button");
    newMapBtn.id = "new-map-button";
    newMapBtn.textContent = "Stwórz nową mapę";
    sidebar.appendChild(newMapBtn);

    loadMapBtn.onclick = () => {
      document.getElementById("load-map-modal").style.display = "block";
    };

    // CREATE MODAL STRUCTURE after loadMapBtn click
    const modalOverlay = document.createElement("div");
    modalOverlay.id = "load-map-modal";

    // Modal content container
    const modalContent = document.createElement("div");
    modalContent.id = "load-map-modal-content";

    // Close button
    const closeBtn = document.createElement("span");
    closeBtn.id = "close-modal";
    closeBtn.innerHTML = "&times;";
    modalContent.appendChild(closeBtn);

    // Title
    const title = document.createElement("h3");
    title.textContent = "Załaduj dane mapy";
    modalContent.appendChild(title);

    // JSON input
    const jsonLabel = document.createElement("label");
    jsonLabel.textContent = "Definicja stylu mapy w formacie JSON:";
    const jsonInput = document.createElement("input");
    jsonInput.type = "file";
    jsonInput.id = "json-file";
    jsonInput.accept = ".json";
    modalContent.appendChild(jsonLabel);
    modalContent.appendChild(jsonInput);

    // CSV input
    const csvLabel = document.createElement("label");
    csvLabel.textContent = "CSV z danymi:";
    const csvInput = document.createElement("input");
    csvInput.type = "file";
    csvInput.id = "csv-file";
    csvInput.accept = ".csv";
    modalContent.appendChild(csvLabel);
    modalContent.appendChild(csvInput);

    // Submit button
    const submitWrapper = document.createElement("div");
    submitWrapper.className = "submit-wrapper";

    const submitBtn = document.createElement("button");
    submitBtn.id = "submit-load";
    submitBtn.textContent = "Załaduj";
    submitWrapper.appendChild(submitBtn);

    modalContent.appendChild(submitWrapper);

    // Assemble and append
    modalOverlay.appendChild(modalContent);
    document.body.appendChild(modalOverlay);

    // Open/close behavior
    loadMapBtn.onclick = () => {
      modalOverlay.style.display = "flex";
    };

    document.addEventListener("click", (e) => {
      if (e.target.id === "close-modal" || e.target.id === "load-map-modal") {
        modalOverlay.style.display = "none";
      }
    });

    document.getElementById("submit-load").onclick = async () => {
      const jsonFile = document.getElementById("json-file").files[0];
      const csvFile = document.getElementById("csv-file").files[0];

      if (!jsonFile || !csvFile) {
        alert("Proszę wybrać pliki JSON i CSV.");
        return;
      }

      try {
        // Read JSON
        const jsonText = await jsonFile.text();
        const newMetadata = JSON.parse(jsonText);

        // Append to metadata
        metadata.push(newMetadata);

        // Read CSV (assume ; separator)
        const csvText = await csvFile.text();
        const newDataRows = d3.dsvFormat(";").parse(csvText);

        // Create map for fast lookup: point_id → row
        const newDataMap = new Map();
        for (const row of newDataRows) {
          newDataMap.set(row.point_id, row);
        }

        // Extend existing data rows
        for (const row of data) {
          const newValues = newDataMap.get(row.point_id);
          if (newValues) {
            for (const [key, value] of Object.entries(newValues)) {
              if (key !== "point_id") {
                row[key] = value;
              }
            }
          }
        }

        // Close modal
        document.getElementById("load-map-modal").style.display = "none";

        // Reload the sidebar
        renderSidebar();
      } catch (err) {
        alert("Błąd podczas ładowania danych: " + err.message);
        console.error(err);
      }
    };

    newMapBtn.onclick = () => {
      editing_mode = true;
      renderSidebar();
    };

    // Re-populate map selection and author if metadata is available
    if (metadata && Array.isArray(metadata)) {
      metadata.forEach(entry => {
        const opt = document.createElement("option");
        opt.value = entry.map_id;
        opt.textContent = entry.map_id + " " + entry.map_name;
        select.appendChild(opt);
      });

      select.addEventListener("change", () => {
        const selectedId = select.value;
        const selectedMeta = metadata.find(m => m.map_id === selectedId);

        if (selectedMeta) {
          authorBox.textContent = selectedMeta.author || "";
        }

        drawMap(selectedId, metadata, undefined);
      });

      if (metadata.length > 0) {
        select.value = metadata[0].map_id;
        authorBox.textContent = metadata[0].author || "";
        drawMap(metadata[0].map_id, metadata, undefined);
      }
    }
  }
}


////////////////////////////////////////////////////// Logic for map creating //////////////////////////////////////////////////////////////

function createDecoratorSelector(decoratorType, items, prechosenOption = "") {
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.userSelect = "none";

  // Current selected display
  const selectedDisplay = document.createElement("div");
  selectedDisplay.style.border = "1px solid #ccc";
  selectedDisplay.style.padding = "6px 8px";
  selectedDisplay.style.cursor = "pointer";
  selectedDisplay.style.display = "flex";
  selectedDisplay.style.alignItems = "center";
  selectedDisplay.style.gap = "6px";

  // Placeholder text when nothing selected
  selectedDisplay.textContent = "Wybierz dekorator";

  const iconWrapper = document.createElement("div");
  selectedDisplay.prepend(iconWrapper);

  // Arrow
  const arrow = document.createElement("span");
  arrow.textContent = "▼";
  arrow.style.marginLeft = "auto";
  selectedDisplay.appendChild(arrow);

  container.appendChild(selectedDisplay);

  // Dropdown list (hidden by default)
  const dropdown = document.createElement("div");
  dropdown.style.position = "absolute";
  dropdown.style.top = "100%";
  dropdown.style.left = "0";
  dropdown.style.right = "0";
  dropdown.style.border = "1px solid #ccc";
  dropdown.style.backgroundColor = "#fff";
  dropdown.style.maxHeight = "150px";
  dropdown.style.overflowY = "auto";
  dropdown.style.zIndex = "1001";
  dropdown.style.display = "none";
  container.appendChild(dropdown);

  // Function to update selected display with chosen name
  function setSelected(name) {
    iconWrapper.innerHTML = "";
    iconWrapper.appendChild(createLegendIcon(decoratorType, name, false));
    selectedDisplay.textContent = "";
    selectedDisplay.appendChild(iconWrapper);
    const label = document.createElement("span");
    label.textContent = name;
    selectedDisplay.appendChild(label);
    selectedDisplay.appendChild(arrow);

    // Dispatch event to notify external listeners
    container.dispatchEvent(new CustomEvent("decoratorSelected", {
      detail: { decoratorType, decoratorName: name },
      bubbles: true
    }));
  }

  // Populate dropdown options
  items.forEach(name => {
    const option = document.createElement("div");
    option.style.padding = "6px 8px";
    option.style.display = "flex";
    option.style.alignItems = "center";
    option.style.gap = "6px";
    option.style.cursor = "pointer";

    // Create icon element
    const icon = createLegendIcon(decoratorType, name, false);
    icon.style.width = "18px";
    icon.style.height = "18px";
    iconWrapper.style.width = "18px";
    iconWrapper.style.height = "18px";

    option.appendChild(icon);
    const label = document.createElement("span");
    label.textContent = name;
    option.appendChild(label);

    option.addEventListener("click", () => {
      setSelected(name);
      dropdown.style.display = "none";
    });

    dropdown.appendChild(option);
  });

  selectedDisplay.addEventListener("click", () => {
    dropdown.style.display = dropdown.style.display === "none" ? "block" : "none";
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", e => {
    if (!container.contains(e.target)) {
      dropdown.style.display = "none";
    }
  });

  // If prechosenOption is valid, set it as selected right away
  if (prechosenOption && items.includes(prechosenOption)) {
    setSelected(prechosenOption);
  }

  return container;
}

/************************************************* Layer editing sidebar *******************************************/

function layerRightSidebar(saveEditedLayer, layerMetadata, preselectedPoints) {

  document.getElementById("right-sidebar")?.remove();

  const rightSidebar = document.createElement("aside");
  rightSidebar.id = "right-sidebar";
  rightSidebar.classList.add("right-sidebar");
  // You can remove inline styles now since CSS covers them, but left here just in case
  rightSidebar.style.position = "absolute";
  rightSidebar.style.top = "0";
  rightSidebar.style.right = "0";
  rightSidebar.style.width = "300px";
  rightSidebar.style.height = "100%";
  rightSidebar.style.backgroundColor = "#f0f0f0";
  rightSidebar.style.padding = "16px";
  rightSidebar.style.borderLeft = "1px solid #ccc";
  rightSidebar.style.boxShadow = "-2px 0 4px rgba(0,0,0,0.1)";
  rightSidebar.style.zIndex = "1000";

  // Layer name
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Nazwa warstwy";
  rightSidebar.appendChild(nameLabel);

  const nameRow = document.createElement("div");
  nameRow.style.display = "flex";
  nameRow.style.gap = "8px";
  nameRow.style.marginBottom = "16px";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "np. granice dialektów";
  nameInput.style.flex = "1";

  // Check if layerMetadata has a key "name" and set the input value
  if (layerMetadata && "name" in layerMetadata) {
    nameInput.value = layerMetadata.name;
  }

  nameRow.appendChild(nameInput);
  rightSidebar.appendChild(nameRow);

  // Layer type
  const typeLabel = document.createElement("label");
  typeLabel.textContent = "Typ warstwy";
  rightSidebar.appendChild(typeLabel);

  const typeSelect = document.createElement("select");
  typeSelect.style.marginTop = "4px";
  rightSidebar.appendChild(typeSelect);

  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";      // empty string means no selection
  defaultOpt.textContent = "-- Wybierz typ warstwy --";
  defaultOpt.selected = true; // make it selected by default
  typeSelect.appendChild(defaultOpt);

  ["Symbol", "Powierzchnia", "Granica"].forEach(option => {
    const opt = document.createElement("option");
    opt.value = option;
    opt.textContent = option;
    typeSelect.appendChild(opt);
  });

  const textToDecorTypeId = {
    "Symbol": "symbol",
    "Powierzchnia": "area_fill",
    "Granica": "border"
  };

  // Check if the decorator type value was already passed in the metadata. If yes, use it.
  const keys = { symbol: "Symbol", area_fill: "Powierzchnia", border: "Granica" };
  const layerKeys = Object.keys(keys);
  const preselectedKey = layerKeys.find(key => layerMetadata?.hasOwnProperty(key));
  typeSelect.value = preselectedKey ? keys[preselectedKey] : "";


  // Placeholder for decorator select
  const decoratorContainer = document.createElement("div");
  decoratorContainer.style.marginTop = "16px";
  rightSidebar.appendChild(decoratorContainer);

  // Container for selected points label + scrollable container
  let selectedPointsLabel = null;
  let selectedPointsContainer = null;
  let saveButton = null;

  // Define your event handler as a separate function:
  function onTypeSelectChange() {
    decoratorContainer.innerHTML = "";
    if (selectedPointsLabel) selectedPointsLabel.remove();
    if (selectedPointsContainer) selectedPointsContainer.remove();

    const selected = typeSelect.value;
    if (!selected) return;

    let items = [];

    if (selected === "Symbol") {
      items = getAllSymbolNames();
    } else if (selected === "Powierzchnia") {
      items = Object.keys(areaFillStyles || {});
    } else if (selected === "Granica") {
      items = Object.keys(borderStyles || {});
    }

    const selectedType = textToDecorTypeId[selected];

    let prechosenOption;
    if (layerMetadata?.[selectedType]) {
      prechosenOption = layerMetadata[selectedType];
    }
    else {
      prechosenOption = "";
    }

    const decoratorSelector = createDecoratorSelector(selectedType, items, prechosenOption);
    decoratorContainer.appendChild(decoratorSelector);

    // Add listener
    function handleDecoratorSelected(e) {
      layerMetadata[selectedType] = e.detail.decoratorName;

      // Add "Zapisz" button below decorator selector
      if (!saveButton) {
        saveButton = document.createElement("button");
        saveButton.textContent = "Zapisz";
        saveButton.style.marginTop = "12px";
        saveButton.style.padding = "10px";
        saveButton.style.backgroundColor = "#007bff";
        saveButton.style.color = "white";
        saveButton.style.border = "none";
        saveButton.style.cursor = "pointer";
        saveButton.style.borderRadius = "4px";
        rightSidebar.appendChild(saveButton);

        saveButton.addEventListener("click", () => {
          const selectedIds = layerControl.getSelectedPointIds();
          layerMetadata["name"] = nameInput.value;
          saveEditedLayer(layerMetadata, selectedIds);

          cleanEditingEnv();

          const layerBox = document.getElementById(`layer-box-${layerMetadata["layer_id"]}`);

          // Trim name to 20 characters
          let name = nameInput.value.trim();
          if (name.length > 20) {
            name = name.slice(0, 20) + "...";
          }

          // Find the label <span> inside the layerBox
          const label = layerBox.querySelector("span"); // the first span is the label
          if (label) {
            label.textContent = `${layerMetadata["layer_id"]}: ${name}`;
          }
        });
      }

      if (!selectedPointsLabel) {
        selectedPointsLabel = document.createElement("label");
        selectedPointsLabel.textContent = "Wybrane punkty";
        selectedPointsLabel.style.marginTop = "16px";
        rightSidebar.appendChild(selectedPointsLabel);
      }

      if (!selectedPointsContainer) {
        selectedPointsContainer = document.createElement("div");
        selectedPointsContainer.id = "selected-points-container";
        rightSidebar.appendChild(selectedPointsContainer);
      }

      // Draw the map and add the editing toolkit
      const layerControl = drawMap(undefined, undefined, preselectedPoints = preselectedPoints);
    }

    decoratorSelector.addEventListener("decoratorSelected", handleDecoratorSelected);

    // 🩹 Trigger manually if prechosen
    if (prechosenOption && items.includes(prechosenOption)) {
      handleDecoratorSelected({
        detail: {
          decoratorType: selectedType,
          decoratorName: prechosenOption
        }
      });
    }
  }

  typeSelect.addEventListener("change", onTypeSelectChange);

  // Call once on init to set decoratorSelector if there is a preselected type
  if (typeSelect.value) {
    onTypeSelectChange();
  }

  typeSelect.addEventListener("change", onTypeSelectChange);

  document.body.appendChild(rightSidebar);
}


////////////////////////////////////////////////////// Logic for map loading ///////////////////////////////////////////////////////////////


////////////////////////////////////////////////////// Logic for map showing ///////////////////////////////////////////////////////////////

/**************************** Define function for legend decorators preparation ****************************/
function createLegendIcon(decorator_type, decorator_name, asHTML = false) {
  const symbolDiv = document.createElement("div");
  symbolDiv.className = "legend-symbol";
  symbolDiv.style.width = "24px";
  symbolDiv.style.height = "24px";
  symbolDiv.style.position = "relative";

  if (decorator_type === "symbol") {
    symbolDiv.innerHTML = getSymbol(decorator_name) || "";

  } else if (decorator_type === "border") {
    const borderConfig = borderStyles[decorator_name];
    if (borderConfig) {
      const legendStyle = borderConfig.legendStyle || {};
      const line = document.createElement("div");
      line.style.width = "100%";
      line.style.height = "2px";
      line.style.position = "absolute";
      line.style.top = "50%";
      line.style.left = "0";
      line.style.transform = "translateY(-50%)";

      if (legendStyle.borderTop) line.style.borderTop = legendStyle.borderTop;
      if (legendStyle.backgroundColor) line.style.backgroundColor = legendStyle.backgroundColor;
      symbolDiv.appendChild(line);

      if (borderConfig.decorator?.type === "marker") {
        const html = borderConfig.decorator.symbolOptions?.markerOptions?.icon?.options?.html;
        if (html) {
          const markerEl = document.createElement("div");
          markerEl.innerHTML = html;
          markerEl.style.position = "absolute";
          markerEl.style.left = "50%";
          markerEl.style.top = "50%";

          let shiftY = "-50%";
          let shiftX = "-50%";
          let rotation = "0deg";

          const decoratorLegendStyle = borderConfig.decorator.legendStyle || {};
          if (decoratorLegendStyle.upwardShift) {
            shiftY = `calc(-50% - ${decoratorLegendStyle.upwardShift})`;
          }
          if (decoratorLegendStyle.rotation) {
            rotation = `${decoratorLegendStyle.rotation}deg`;
          }

          markerEl.style.transform = `translate(${shiftX}, ${shiftY}) rotate(${rotation})`;
          symbolDiv.appendChild(markerEl);
        }
      }
    }

  } else if (decorator_type === "area_fill") {
    const fillConfig = areaFillStyles[decorator_name];
    if (fillConfig?.legendStyle) {
      const style = fillConfig.legendStyle;
      for (const key in style) {
        symbolDiv.style[key] = style[key];
      }
    }
  }

  return asHTML ? symbolDiv.outerHTML : symbolDiv;
}

/**************************** Define Legend ****************************/

let symbolLayer;
let voronoiLayers;

function updateLegend(legendList, mapName, voronoiLayers, map) {
  const container = document.querySelector('.legend-container');
  container.innerHTML = "";

  if (mapName) {
    const title = document.createElement("h3");
    title.textContent = mapName;
    title.style.marginBottom = "8px";
    container.appendChild(title);
  }

  legendList.forEach(entry => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.style.display = "flex";
    item.style.alignItems = "center";
    item.style.marginBottom = "6px";
    item.style.gap = "6px";
    item.style.cursor = "pointer";

    let symbolEl = null;

    if (entry.symbol) {
      symbolEl = createLegendIcon("symbol", entry.symbol);
    } else if (entry.border) {
      symbolEl = createLegendIcon("border", entry.border);
    } else if (entry.area_fill) {
      symbolEl = createLegendIcon("area_fill", entry.area_fill);
    }

    if (symbolEl) item.appendChild(symbolEl);

    const labelSpan = document.createElement("span");
    labelSpan.className = "legend-name";
    labelSpan.textContent = entry.name || entry.value;
    item.appendChild(labelSpan);

    let visible = true;

    item.addEventListener("click", () => {
      const layers = voronoiLayers[entry.layer_id];
      if (!layers) return;

      const { borders = [], areaFills = [] } = layers;
      const allLayers = [...borders, ...areaFills];

      allLayers.forEach(layer => {
        visible ? map.removeLayer(layer) : map.addLayer(layer);
      });

      visible = !visible;
      item.style.opacity = visible ? "1" : "0.4";
    });

    container.appendChild(item);
  });
}

/**************************** Draw Map ****************************/

function drawMap(mapId = "", metadata=[], preselectedPoints = []) {

  cleanMap();

  if (mapId != "") {
    const mapMeta = metadata.find(m => m.map_id === mapId);
    if (!mapMeta) return;

    const legendList = mapMeta.layers || [];

    /**************************** Define features list with map data ****************************/

    const features = loadFeatures(mapId, legendList);

    /**************************** Draw data on the map ****************************/

    // Add symbols to the map
    symbolLayer = addSymbolLayerToMap(features, map);

    // Draw the borders and area fills using Voronoi diagram approach
    voronoiLayers = drawVoronoiLayers(features, legendList, map, clippingGeometry);

    // Update the legend to show the decorators and descriptions
    updateLegend(legendList, mapMeta.map_name, voronoiLayers, map);
    
    return {"layer": symbolLayer}
  }
  else {
    const features = loadFeatures();

    // Add symbols to the map
    const layerControl = addEmptyPointsLayer(features, map, preselectedPoints)

    symbolLayer = layerControl.layer

    return layerControl
  }
}

///////////////////////////////////////////////////// Initialize Everything //////////////////////////////////////////////////////////

init();