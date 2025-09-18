const busRoutes = {
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            id: 'route-01',
            properties: {
                route_id: '01',
                name: 'Harvard Sq - Nubian Station',
                color: '#e74c3c',
                description: 'Core north-south spine along Massachusetts Ave and Melnea Cass Blvd.'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-71.1189, 42.3733],
                    [-71.1108, 42.3686],
                    [-71.1036, 42.3644],
                    [-71.0959, 42.3618],
                    [-71.0881, 42.3574],
                    [-71.0785, 42.3513],
                    [-71.0711, 42.3439],
                    [-71.0739, 42.3377],
                    [-71.0839, 42.3326],
                    [-71.0831, 42.3296]
                ]
            }
        },
        {
            type: 'Feature',
            id: 'route-66',
            properties: {
                route_id: '66',
                name: 'Harvard Sq - Nubian Station via Brookline',
                color: '#27ae60',
                description: 'Crosstown connection threading Allston, Brookline Village, and Mission Hill.'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-71.1189, 42.3733],
                    [-71.1308, 42.3647],
                    [-71.1281, 42.3588],
                    [-71.1250, 42.3523],
                    [-71.1210, 42.3443],
                    [-71.1160, 42.3377],
                    [-71.1105, 42.3318],
                    [-71.1030, 42.3270],
                    [-71.0965, 42.3294],
                    [-71.0890, 42.3240]
                ]
            }
        },
        {
            type: 'Feature',
            id: 'route-39',
            properties: {
                route_id: '39',
                name: 'Forest Hills - Back Bay',
                color: '#2980b9',
                description: 'Frequent Arborway-Huntington Ave trunk route with key LMA access.'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-71.1138, 42.3007],
                    [-71.1090, 42.3076],
                    [-71.1040, 42.3185],
                    [-71.1000, 42.3268],
                    [-71.0942, 42.3346],
                    [-71.0888, 42.3400],
                    [-71.0828, 42.3450],
                    [-71.0779, 42.3477],
                    [-71.0735, 42.3495]
                ]
            }
        },
        {
            type: 'Feature',
            id: 'route-sl4',
            properties: {
                route_id: 'SL4',
                name: 'Nubian Station - South Station',
                color: '#8e44ad',
                description: 'Silver Line branch linking Roxbury to Downtown via Washington St.'
            },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [-71.0831, 42.3296],
                    [-71.0797, 42.3332],
                    [-71.0762, 42.3388],
                    [-71.0723, 42.3450],
                    [-71.0666, 42.3505],
                    [-71.0606, 42.3526],
                    [-71.0553, 42.3520],
                    [-71.0536, 42.3489]
                ]
            }
        }
    ]
}

export default busRoutes