import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Data
const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] }

// Layer Configs
const STOP_LAYER_CONFIGS = [
    {
        arcgisLayerId: 2,
        sourceId: 'bus-stops-overview-source',
        layerId: 'bus-stops-overview-layer',
        minzoom: 13.5,
        maxzoom: 15.4,
        circleRadius: 3.2,
        circleOpacity: 0.55
    },
    {
        arcgisLayerId: 1,
        sourceId: 'bus-stops-community-source',
        layerId: 'bus-stops-community-layer',
        minzoom: 15.4,
        maxzoom: 17.2,
        circleRadius: 3.9,
        circleOpacity: 0.65
    },
    {
        arcgisLayerId: 0,
        sourceId: 'bus-stops-detail-source',
        layerId: 'bus-stops-detail-layer',
        minzoom: 17.2,
        circleRadius: 4.6,
        circleOpacity: 0.75
    }
]

// Colors
const COLOR_PALETTE = [
    '#e74c3c',
    '#27ae60',
    '#2980b9',
    '#8e44ad',
    '#f39c12',
    '#16a085',
    '#d35400',
    '#2c3e50',
    '#c0392b',
    '#9b59b6',
    '#1abc9c',
    '#34495e'
]

// Helper Functions
function getRouteColor(routeId) {
    if (!routeId) return '#555555'

    let hash = 0
    for (let index = 0; index < routeId.length; index += 1) {
        hash = routeId.charCodeAt(index) + ((hash << 5) - hash)
        hash &= hash
    }

    const paletteIndex = Math.abs(hash) % COLOR_PALETTE.length
    return COLOR_PALETTE[paletteIndex]
}

function normalizeRouteFeature(feature, index) {
    if (!feature || !feature.geometry) return null

    const properties = feature.properties ?? {}
    const routeNumber = properties.route_num != null ? String(properties.route_num).trim() : ''
    const routeName = properties.route_desc != null ? String(properties.route_desc).trim() : ''

    const fallbackIdParts = []
    if (routeNumber) {
        fallbackIdParts.push(routeNumber)
    }

    const fallbackId = fallbackIdParts.join('-') || feature.id || properties.FID || `route-${index}`
    const featureId = feature.id ?? properties.SHAPE_ID ?? properties.FID ?? fallbackId
    const routeId = routeNumber || fallbackId
    const displayName = routeName || (routeNumber ? `Route ${routeNumber}` : 'MBTA Bus Route')

    return {
        ...feature,
        id: featureId,
        properties: {
            ...properties,
            route_id: routeId,
            name: displayName,
            color: getRouteColor(routeId)
        }
    }
}

function getErrorMessage(error, fallbackMessage) {
    if (error instanceof Error) return error.message
    if (typeof error === 'string' && error.trim() !== '') return error
    return fallbackMessage
}

// Async Functions
async function fetchRoutesFromGeoJson() {
    let lastError = null

    try {
        const response = await fetch('/data/routes.geojson', { cache: 'no-cache' })

        if (!response.ok) {
            const message = await response.text()
            throw new Error(`request failed with status ${response.status}: ${message}`)
        }

        const featureCollection = await response.json()

        if (!featureCollection || !Array.isArray(featureCollection.features)) {
            throw new Error('missing features array in GeoJSON file')
        }

        const features = featureCollection.features
            .map((feature, index) => normalizeRouteFeature(feature, index))
            .filter(Boolean)

        if (!features.length) {
            throw new Error('no usable bus routes found in GeoJSON file')
        }

        return { type: 'FeatureCollection', features }
    } catch (error) {
        lastError =
            error instanceof Error
                ? error
                : new Error('Unexpected error while loading routes GeoJSON')
    }

    const message =
        lastError?.message
            ? `Unable to load routes from local GeoJSON: ${lastError.message}`
            : 'Unable to load routes from local GeoJSON file.'

    throw new Error(message)
}

/*
async function fetchMassGisStops() {
    const entries = await Promise.all(
        STOP_LAYER_CONFIGS.map(async (config) => {
            const data = await fetchLayerFeatures(config.arcgisLayerId)
            return [config.sourceId, data]
        })
    )

    return Object.fromEntries(entries)
}
*/

// Component
export default function App() {
    // Ref
    const mapContainer = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const hoveredRouteRef = useRef(null)
    const mapReadyRef = useRef(false)
    const selectedRouteIdRef = useRef(null)

    // State
    const [routesData, setRoutesData] = useState(EMPTY_GEOJSON)
    const [stopData, setStopData] = useState(null)
    const [selectedRouteId, setSelectedRouteId] = useState(null)
    const [mapIsReady, setMapIsReady] = useState(false)
    const [isFetchingData, setIsFetchingData] = useState(false)
    const [dataError, setDataError] = useState(null)
    const [stopDataError, setStopDataError] = useState(null)

    // Memo
    const legendItems = useMemo(
        () =>
            routesData.features
                .slice()
                .sort((a, b) => {
                    const aCode = a.properties?.route_id || ''
                    const bCode = b.properties?.route_id || ''
                    return aCode.localeCompare(bCode, undefined, { numeric: true, sensitivity: 'base' })
                })
                .map((feature) => ({
                id: feature.id,
                code: feature.properties.route_id,
                name: feature.properties.name,
                color: feature.properties.color,
                isSelected: feature.id === selectedRouteId,
            })),
        [routesData, selectedRouteId]
    )

    useEffect(() => {
        if (mapRef.current) return

        mapRef.current = new maplibregl.Map({
            container: mapContainer.current,
            style: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
            center: [-71.0589, 42.3601], // Boston
            zoom: 12
        })

        // Add controls
        mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: true }))
        mapRef.current.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }))

        mapRef.current.on('load', () => {
            mapReadyRef.current = true
            setMapIsReady(true)

            popupRef.current = new maplibregl.Popup({
                closeButton: false,
                closeOnMove: true,
                offset: 12
            })

            mapRef.current.addSource('bus-routes', {
                type: 'geojson',
                data: EMPTY_GEOJSON
            })

            mapRef.current.addLayer({
                id: 'bus-routes-casing',
                type: 'line',
                source: 'bus-routes',
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 7,
                    'line-opacity': 0.55
                }
            })

            mapRef.current.addLayer({
                id: 'bus-routes-line',
                type: 'line',
                source: 'bus-routes',
                paint: {
                    'line-color': ['get', 'color'],
                    'line-width': [
                        'case',
                        ['boolean', ['feature-state', 'selected'], false],
                        6,
                        ['boolean', ['feature-state', 'hover'], false],
                        5,
                        4
                    ],
                    'line-opacity': [
                        'case',
                        ['boolean', ['feature-state', 'hover'], false],
                        1,
                        0.9
                    ]
                },
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                }
            })

            STOP_LAYER_CONFIGS.forEach((config) => {
                mapRef.current?.addSource(config.sourceId, {
                    type: 'geojson',
                    data: EMPTY_GEOJSON
                })

                const layerConfig = {
                    id: config.layerId,
                    type: 'circle',
                    source: config.sourceId,
                    minzoom: config.minzoom,
                    paint: {
                        'circle-radius': config.circleRadius,
                        'circle-color': '#1f7bf6',
                        'circle-opacity': config.circleOpacity,
                        'circle-stroke-width': 0.6,
                        'circle-stroke-color': '#ffffff'
                    }
                }

                if (typeof config.maxzoom === 'number') {
                    layerConfig.maxzoom = config.maxzoom
                }

                mapRef.current?.addLayer(layerConfig)
            })

            mapRef.current.on('mouseenter', 'bus-routes-line', () => {
                mapRef.current.getCanvas().style.cursor = 'pointer'
            })

            mapRef.current.on('mouseleave', 'bus-routes-line', () => {
                mapRef.current.getCanvas().style.cursor = ''

                if (hoveredRouteRef.current !== null) {
                    mapRef.current.setFeatureState(
                        { source: 'bus-routes', id: hoveredRouteRef.current },
                        { hover: false }
                    )
                    hoveredRouteRef.current = null
                }
            })

            mapRef.current.on('mousemove', 'bus-routes-line', (event) => {
                if (!event.features?.length) return

                const feature = event.features[0]
                const featureId = feature.id

                if (featureId === undefined || featureId === null) return

                if (hoveredRouteRef.current !== featureId) {
                    if (hoveredRouteRef.current !== null) {
                        mapRef.current.setFeatureState(
                            { source: 'bus-routes', id: hoveredRouteRef.current },
                            { hover: false }
                        )
                    }

                    hoveredRouteRef.current = featureId
                    mapRef.current.setFeatureState({ source: 'bus-routes', id: featureId }, { hover: true })
                }
            })

            mapRef.current.on('click', 'bus-routes-line', (event) => {
                if (!event.features?.length) return

                const feature = event.features[0]
                const featureId = feature.id

                if (featureId === undefined || featureId === null) return

                selectedRouteIdRef.current = featureId
                setSelectedRouteId(featureId)

                const { route_id: routeId, name } = feature.properties

                popupRef.current
                    ?.setLngLat(event.lngLat)
                    .setHTML(
                        `<strong>${routeId} ${name}</strong><p class="popup-hint">Shift + click anywhere on the map to append a waypoint for this route.</p>`
                    )
                    .addTo(mapRef.current)
            })

            mapRef.current.on('click', (event) => {
                if (!mapReadyRef.current) return

                if (event.originalEvent.shiftKey) {
                    if (!selectedRouteIdRef.current) return

                    const { lng, lat } = event.lngLat

                    setRoutesData((current) => ({
                        ...current,
                        features: current.features.map((feature) => {
                            if (feature.id !== selectedRouteIdRef.current) {
                                return feature
                            }

                            const geometry = feature.geometry

                            if (!geometry) {
                                return feature
                            }

                            if (geometry.type === 'LineString') {
                                return {
                                    ...feature,
                                    geometry: {
                                        ...geometry,
                                        coordinates: [...geometry.coordinates, [lng, lat]]
                                    }
                                }
                            }

                            if (geometry.type === 'MultiLineString') {
                                const lineCount = geometry.coordinates.length
                                const targetIndex = Math.max(0, lineCount - 1)
                                const updatedCoordinates = geometry.coordinates.map((segment, index) =>
                                    index === targetIndex ? [...segment, [lng, lat]] : segment
                                )

                                return {
                                    ...feature,
                                    geometry: {
                                        ...geometry,
                                        coordinates: updatedCoordinates
                                    }
                                }
                            }

                            return feature
                        })
                    }))

                    return
                }

                const features = mapRef.current.queryRenderedFeatures(event.point, {
                    layers: ['bus-routes-line']
                })

                if (!features.length) {
                    selectedRouteIdRef.current = null
                    setSelectedRouteId(null)
                    popupRef.current?.remove()
                }
            })
        })

        return () => {
            mapRef.current && mapRef.current.remove()
            mapRef.current = null
            popupRef.current = null
            hoveredRouteRef.current = null
            mapReadyRef.current = false
            selectedRouteIdRef.current = null
            setMapIsReady(false)
        }
    }, [])

    useEffect(() => {
        if (!mapIsReady) return

        let cancelled = false

        const loadData = async () => {
            setIsFetchingData(true)
            setDataError(null)
            setStopDataError(null)

            try {
                const [routesResult] = await Promise.allSettled([
                    fetchRoutesFromGeoJson(),
                    //fetchMassGisStops()
                ])

                if (cancelled) return

                if (routesResult.status === 'fulfilled') {
                    setRoutesData(routesResult.value)
                } else {
                    const message = getErrorMessage(
                        routesResult.reason,
                        'Failed to load routes from the local GeoJSON file.'
                    )
                    setRoutesData(EMPTY_GEOJSON)
                    setDataError(message)
                }
            } finally {
                if (!cancelled) {
                    setIsFetchingData(false)
                }
            }
        }

        loadData()

        return () => {
            cancelled = true
        }
    }, [mapIsReady])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return

        const source = mapRef.current.getSource('bus-routes')
        if (source) {
            source.setData(routesData ?? EMPTY_GEOJSON)
        }
    }, [routesData])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current || !stopData) return

        STOP_LAYER_CONFIGS.forEach((config) => {
            const source = mapRef.current?.getSource(config.sourceId)
            const data = stopData[config.sourceId]

            if (source && data) {
                source.setData(data)
            }
        })
    }, [stopData])

    useEffect(() => {
        selectedRouteIdRef.current = selectedRouteId
    }, [selectedRouteId])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return
        if (selectedRouteId === null) return

        mapRef.current.setFeatureState(
            { source: 'bus-routes', id: selectedRouteId },
            { selected: true }
        )

        return () => {
            if (!mapRef.current || !mapReadyRef.current) return
            mapRef.current.setFeatureState(
                { source: 'bus-routes', id: selectedRouteId },
                { selected: false }
            )
        }
    }, [selectedRouteId])

    return (
        <div className="map-wrap">
            <div className="info-panel">
                <div className="header">
                    <strong>MBTA Bus Frequency Mapper</strong>
                    <p>
                        Explore existing routes, then select one and <kbd>Shift</kbd> + click anywhere on the route to
                        sketch new stops for rapid frequency testing.
                    </p>
                </div>
                <div className="legend">
                    <h2>MBTA Bus Routes</h2>
                    {dataError ? (
                        <p className="legend-error">{dataError}</p>
                    ) : isFetchingData && !legendItems.length ? (
                        <p className="legend-note">Loading bus routes from the local GeoJSON file…</p>
                    ) : null}
                    <div className="legend-items">
                        {legendItems.map((item) => {
                            const rowStyle = item.isSelected
                                ? {
                                      borderColor: item.color,
                                      boxShadow: `0 0 0 3px ${item.color}33`
                                  }
                                : undefined

                            return (
                                <div key={item.id} className="legend-row" style={rowStyle}>
                                    <span
                                        className="legend-swatch"
                                        style={{ backgroundColor: item.color }}
                                        aria-hidden="true"
                                    />
                                    <div className="legend-route">
                                        <strong>
                                            {item.code} <span>{item.name}</span>
                                        </strong>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <p className="legend-note">
                        Routes are sourced from the bundled <code>routes.geojson</code> file. Shift-click the map to
                        append test waypoints for the selected route.
                    </p>
                    {stopDataError ? (
                        <p className="legend-warning">{stopDataError}</p>
                    ) : (
                        <p className="legend-note">
                            MassGIS bus stop overlays continue to load from the live service whenever it is
                            reachable.
                        </p>
                    )}
                </div>
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}