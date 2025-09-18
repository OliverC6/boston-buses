import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

export default function App() {
    const mapContainer = useRef(null)
    const mapRef = useRef(null)

    useEffect(() => {
        if (mapRef.current) return // initialize map only once

        mapRef.current = new maplibregl.Map({
            container: mapContainer.current,
            style: 'https://demotiles.maplibre.org/style.json',
            center: [-71.0589, 42.3601], // Boston (lng, lat)
            zoom: 12
        })

        // Add controls
        mapRef.current.addControl(new maplibregl.NavigationControl({ showCompass: true }))
        mapRef.current.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }))


        return () => {
            mapRef.current && mapRef.current.remove()
            mapRef.current = null
        }
    }, [])

    return (
        <div className="map-wrap">
            <div className="header">
                <strong>MBTA Bus Scenario Mapper</strong><br />
                Boston basemap — ready for routes
            </div>
            <div ref={mapContainer} className="map" />
        </div>
    )
}