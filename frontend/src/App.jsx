import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import busRoutes from './data/busRoutes'

export default function App() {
    const mapContainer = useRef(null)
    const mapRef = useRef(null)
    const popupRef = useRef(null)
    const hoveredRouteRef = useRef(null)
    const mapReadyRef = useRef(false)
    const selectedRouteIdRef = useRef(null)

    const [routesData, setRoutesData] = useState(busRoutes)
    const [selectedRouteId, setSelectedRouteId] = useState(null)

    const legendItems = useMemo(
        () =>
            routesData.features.map((feature) => ({
                id: feature.id,
                code: feature.properties.route_id,
                name: feature.properties.name,
                color: feature.properties.color,
                isSelected: feature.id === selectedRouteId,
                description: feature.properties.description
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

            popupRef.current = new maplibregl.Popup({
                closeButton: false,
                closeOnMove: true,
                offset: 12
            })

            mapRef.current.addSource('bus-routes', {
                type: 'geojson',
                data: routesData
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

                const { route_id: routeId, name, description } = feature.properties

                popupRef.current
                    ?.setLngLat(event.lngLat)
                    .setHTML(
                        `<strong>${routeId} ${name}</strong><p>${description}</p><p class="popup-hint">Shift + click anywhere on the map to append a waypoint for this route.</p>`
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
                        features: current.features.map((feature) =>
                            feature.id === selectedRouteIdRef.current
                                ? {
                                      ...feature,
                                      geometry: {
                                          ...feature.geometry,
                                          coordinates: [...feature.geometry.coordinates, [lng, lat]]
                                      }
                                  }
                                : feature
                        )
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
        }
    }, [routesData])

    useEffect(() => {
        if (!mapRef.current || !mapReadyRef.current) return

        const source = mapRef.current.getSource('bus-routes')
        if (source) {
            source.setData(routesData)
        }
    }, [routesData])

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
                    <strong>MBTA Bus Scenario Mapper</strong>
                    <p>
                        Explore existing routes, then select one and <kbd>Shift</kbd> + click anywhere on the map to
                        sketch new waypoints for rapid scenario testing.
                    </p>
                </div>
                <div className="legend">
                    <h2>Priority Bus Corridors</h2>
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
                                    <span className="legend-description">{item.description}</span>
                                </div>
                            </div>
                        )
                    })}
                    <p className="legend-note">
                        GeoJSON-driven overlays keep routes editable—perfect for testing diversions or new service
                        patterns.
                    </p>
                </div>
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}