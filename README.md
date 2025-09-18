# boston-buses

## Configuring the MBTA API key for local development

The front-end talks directly to the MBTA v3 API. To avoid hitting the anonymous
rate limits you can register for an API key at
https://api-v3.mbta.com/ and store it in a local environment file that Vite
will read when you run the development server.

1. Create a file named `.env.local` in the `frontend/` directory (it will be
   ignored by Git).
2. Add your key to the file using the `VITE_` prefix that Vite expects:

   ```bash
   echo "VITE_MBTA_API_KEY=your-key-goes-here" >> frontend/.env.local
   ```

3. Restart `npm run dev` (or `npm run build`) so the updated environment
   variable is picked up. The application will automatically attach the key to
   MBTA API requests via the `x-api-key` header.