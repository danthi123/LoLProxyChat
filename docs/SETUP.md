# LoLProxChat Setup Guide

## 1. Supabase Project

1. Go to https://supabase.com and create a free account
2. Create a new project (any name, any region)
3. Go to Settings > API
4. Copy the "Project URL" and "anon/public" key
5. Paste them into src/core/config.ts

No database tables needed - we only use Supabase Realtime (channels/presence/broadcast).

## 2. Overwolf Developer Account

1. Register at https://dev.overwolf.com
2. Create a new app in the developer console
3. Load the dist/ folder as an unpacked extension for testing

## 3. Development

- npm install - install dependencies
- npm run build - development build
- npm run build:prod - production build
- npm test - run tests

## 4. Testing

1. Build the app: npm run build
2. In Overwolf, load dist/ as unpacked extension
3. Launch League of Legends and start a game
4. The overlay should appear near the minimap
5. Other players with the app will appear when in proximity
