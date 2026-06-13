import { defineConfig } from 'vite';
import { createStandaloneViteConfig } from '../scripts/create-standalone-vite-config.mjs';

export default defineConfig(createStandaloneViteConfig(__dirname));
