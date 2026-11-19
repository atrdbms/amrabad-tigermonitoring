// ------------------------------------------------------------------
// Site settings. Edit this file only; app.js reads everything from here.
// ------------------------------------------------------------------
window.ATR_CONFIG = {
  // Branding.
  branding: {
    govLine: "Government of Telangana · Telangana Forest Department",
    titleSmall: "Amrabad Tiger Reserve",
    titleMain: "Tiger Monitoring Management System",
    titleSub: "Camera Trap & Field Monitoring · Nagarkurnool & Nalgonda Districts",
    // Logos are built into index.html, so nothing extra needs uploading.
    // To use different logos, put a file path or link here, e.g. "assets/my-logo.png".
    logoLeft: "",
    logoRight: "",
  },

  // Published Google Sheet (File > Share > Publish to web > CSV).
  // The site reads it live, so new rows appear on the next page load.
  csvUrl:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vT4Y2iDgvgsrobVrerQauLCtB8dnXQpp4UYIU9d1dVEQhlxblrsDlzfnvCDbCis93Q_4szeDFPZY3B1/pub?gid=650403308&single=true&output=csv",

  // Tiger profile photos (optional). Easiest: add a tab named "Tiger_Profiles" to the
  // sheet with columns  Tiger_ID | Profile_Photo_URL | Name | Remarks , publish that tab
  // to the web as CSV, and paste its link here. Leave "" if not used.
  profileCsvUrl: "",
  // Or list them here directly:  "ATR M 19": "https://drive.google.com/file/d/…/view",
  profilePhotos: {
  },

  // Columns ticked by default in the custom report builder.
  customDefaultColumns: ["Sl_No", "Date", "Tiger_ID", "Tiger_evid", "Division", "Range", "Section", "Beat", "Compt_No", "Latitude", "Longitude", "photo_URL"],

  // Boundary layers (KML) shown to everyone. Upload the .kml files to the same GitHub
  // repository (e.g. a folder named kml) and list them here, for example:
  //   { name: "ATR boundary", url: "kml/ATR_boundary.kml" },
  //   { name: "Beats", url: "kml/ATR_beats.kml" },
  // Anyone can also upload a KML/KMZ on the GIS Map page (kept in their browser only).
  kmlLayers: [
  ],

  // Map starts here before the records are plotted (Amrabad TR, Telangana).
  mapCenter: [16.35, 78.85],
  mapZoom: 10,

  // Which sheet column feeds each filter. Each entry lists accepted header
  // names; matching ignores case, spaces, dots, underscores and hyphens.
  // If your header is different, just add it to the list.
  columns: {
    year:     ["Year", "Yr"],
    month:    ["Month", "Mon"],
    tigerId:  ["Tiger_ID", "Tiger ID", "TigerID", "Tiger", "Tiger No", "Tiger Code", "Individual ID"],
    division: ["Division", "Div"],
    range:    ["Range", "Range Name"],
    section:  ["Section", "Section Name"],
    beat:     ["Beat", "Beat Name"],
    block:    ["Block", "Block Name"],
    compt:    ["Compt_No", "Compt No", "Compartment", "Compartment No", "Compt", "Cmpt No"],
    lat:      ["Latitude", "Lat", "Lat (N)", "Latitude (N)", "Y"],
    lon:      ["Longitude", "Long", "Lon", "Lng", "Long (E)", "Longitude (E)", "X"],
    photo:    ["photo_URL", "Photo URL", "Photo Link", "Image URL", "Photo", "Photos", "Photo Link", "Photo URL", "Image", "Image Link", "Image URL", "Photograph", "Picture"],
    photoName: ["Photo", "Photo Name", "Image Name"],
    evidence: ["Tiger_evid", "Tiger Evidence", "Evidence", "Evidence Type"],
    date:     ["Date", "Date of Capture", "Capture Date", "Observation Date", "Date of Observation", "Timestamp"],
  },

  // Filters shown in the filter bar, in this order.
  filterOrder: ["year", "month", "division", "range", "section", "beat", "compt", "tigerId"],

  labels: {
    year: "Year", month: "Month", tigerId: "Tiger ID", division: "Division",
    range: "Range", section: "Section", beat: "Beat", block: "Block", compt: "Compt. No",
  },
};
