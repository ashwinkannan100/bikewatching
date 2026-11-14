import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Public browser token supplied by the project owner.
mapboxgl.accessToken = 'pk.eyJ1IjoiYXNod2luLWthbm5hbiIsImEiOiJjbXdmdjdnbjUwNW0yMnhwcHM2aHhpazA0In0.GR61aXTSUBbVFKtqrbHihw';

const DATA = {
  stations: 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json',
  trips: 'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
  bostonLanes: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  cambridgeLanes: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
};

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/light-v11',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 10,
  maxZoom: 18,
  pitch: 0,
});
map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-left');
map.addControl(new mapboxgl.ScaleControl({ maxWidth: 100, unit: 'imperial' }), 'bottom-left');

const svg = d3.select('#map').select('svg');
const loading = document.querySelector('#map-loading');
const errorBox = document.querySelector('#error-message');
const slider = document.querySelector('#time-slider');
const selectedTime = document.querySelector('#selected-time');
const anyTime = document.querySelector('#any-time');

let stations = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);
let circles;
let radiusScale;
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
  loading?.classList.add('is-hidden');
}

function minuteOf(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const normalized = ((minutes % 1440) + 1440) % 1440;
  return new Date(2000, 0, 1, Math.floor(normalized / 60), normalized % 60)
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Return all rides whose start/end event falls within +/- 60 minutes.
// The buckets make slider updates much faster than rescanning all 260K rides.
function filterByMinute(buckets, minute) {
  if (minute === -1) return buckets.flat();
  const selected = [];
  for (let offset = -60; offset <= 60; offset += 1) {
    const index = (minute + offset + 1440) % 1440;
    selected.push(...buckets[index]);
  }
  return selected;
}

function computeStationTraffic(baseStations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    (rides) => rides.length,
    (ride) => ride.start_station_id,
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    (rides) => rides.length,
    (ride) => ride.end_station_id,
  );

  return baseStations.map((station) => {
    const id = station.short_name ?? station.Number ?? station.station_id;
    const stationDepartures = departures.get(id) ?? 0;
    const stationArrivals = arrivals.get(id) ?? 0;
    return {
      ...station,
      stationId: id,
      departures: stationDepartures,
      arrivals: stationArrivals,
      totalTraffic: stationDepartures + stationArrivals,
    };
  });
}

function projectStation(station) {
  const longitude = Number(station.lon ?? station.Long ?? station.longitude);
  const latitude = Number(station.lat ?? station.Lat ?? station.latitude);
  const point = map.project([longitude, latitude]);
  return { cx: point.x, cy: point.y };
}

function updatePositions() {
  if (!circles) return;
  circles
    .attr('cx', (d) => projectStation(d).cx)
    .attr('cy', (d) => projectStation(d).cy);
}

function updateCircles(timeFilter) {
  const currentStations = computeStationTraffic(stations, timeFilter);
  const maxTraffic = d3.max(currentStations, (d) => d.totalTraffic) || 1;
  radiusScale.domain([0, maxTraffic]).range(timeFilter === -1 ? [0, 25] : [2.5, 34]);

  circles = svg.selectAll('circle')
    .data(currentStations, (d) => d.stationId)
    .join(
      (enter) => enter.append('circle'),
      (update) => update,
      (exit) => exit.remove(),
    )
    .attr('r', (d) => radiusScale(d.totalTraffic))
    .style('--departure-ratio', (d) =>
      `${(d.totalTraffic === 0 ? 0.5 : stationFlow(d.departures / d.totalTraffic)) * 100}%`)
    .attr('aria-label', (d) =>
      `${d.name ?? d.NAME ?? 'Bluebikes station'}: ${d.totalTraffic} rides`)
    .each(function (d) {
      const stationName = d.name ?? d.NAME ?? 'Bluebikes station';
      const municipality = d.municipality ?? d.Municipality ?? '';
      d3.select(this).selectAll('title').data([d]).join('title')
        .text(`${stationName}${municipality ? ` · ${municipality}` : ''}\n${d.totalTraffic.toLocaleString()} total rides\n${d.departures.toLocaleString()} departures · ${d.arrivals.toLocaleString()} arrivals`);
    });

  updatePositions();
}

function updateTimeDisplay() {
  const value = Number(slider.value);
  if (value === -1) {
    selectedTime.textContent = 'All day';
    anyTime.textContent = 'All March 2024 rides';
  } else {
    selectedTime.textContent = formatTime(value);
    anyTime.textContent = 'Trips within ±1 hour';
  }
  updateCircles(value);
}

async function addBikeLaneLayer(id, url, color, width, opacity) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${id} GeoJSON (${response.status}).`);
  const geojson = await response.json();
  map.addSource(id, { type: 'geojson', data: geojson });
  map.addLayer({
    id: `${id}-line`,
    type: 'line',
    source: id,
    paint: {
      'line-color': color,
      'line-width': ['interpolate', ['linear'], ['zoom'], 10, width * 0.6, 16, width],
      'line-opacity': opacity,
    },
  });
}

map.on('load', async () => {
  try {
    await Promise.all([
      addBikeLaneLayer('boston-bike-lanes', DATA.bostonLanes, '#329b78', 2.8, 0.58),
      addBikeLaneLayer('cambridge-bike-lanes', DATA.cambridgeLanes, '#207e63', 3.2, 0.72),
    ]);

    const [stationData, trips] = await Promise.all([
      d3.json(DATA.stations),
      d3.csv(DATA.trips, (trip) => ({
        ...trip,
        started_at: new Date(trip.started_at),
        ended_at: new Date(trip.ended_at),
      })),
    ]);

    const rawStations = stationData?.data?.stations ?? stationData?.stations ?? [];
    if (!rawStations.length || !trips.length) {
      throw new Error('The station or trip dataset loaded but contained no records.');
    }

    // Pre-index each ride by its departure minute and arrival minute.
    for (const trip of trips) {
      if (!Number.isNaN(+trip.started_at)) departuresByMinute[minuteOf(trip.started_at)].push(trip);
      if (!Number.isNaN(+trip.ended_at)) arrivalsByMinute[minuteOf(trip.ended_at)].push(trip);
    }

    stations = rawStations.filter((station) => {
      const lat = Number(station.lat ?? station.Lat ?? station.latitude);
      const lon = Number(station.lon ?? station.Long ?? station.longitude);
      return Number.isFinite(lat) && Number.isFinite(lon);
    });

    radiusScale = d3.scaleSqrt().domain([0, 1]).range([0, 25]);
    circles = svg.selectAll('circle').data([]).join('circle');

    // Initial render and responsive map overlay updates.
    updateTimeDisplay();
    map.on('move', updatePositions);
    map.on('zoom', updatePositions);
    map.on('resize', updatePositions);
    map.on('moveend', updatePositions);
    slider.addEventListener('input', updateTimeDisplay);

    loading.classList.add('is-hidden');
    console.info(`BikeWatching loaded ${stations.length} stations and ${trips.length.toLocaleString()} March 2024 rides.`);
  } catch (error) {
    console.error(error);
    showError(`Some map data could not be loaded. Check your internet connection and refresh. Details: ${error.message}`);
  }
});

map.on('error', (event) => {
  // Mapbox may emit transient tile errors; only surface style/auth errors.
  if (event?.error?.status === 401 || event?.error?.status === 403) {
    showError('Mapbox could not authenticate this public token. Check that it is active and that URL restrictions allow your GitHub Pages domain.');
  }
});
