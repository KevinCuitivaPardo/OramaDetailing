import security from 'eslint-plugin-security';
import globals from 'globals';

// Análisis estático de seguridad (npm run lint:security): reglas de eslint-plugin-security sobre el servidor y el panel.
export default [
  security.configs.recommended,
  {
    files: ['server/**/*.js', 'shared/**/*.js', 'scripts/**/*.mjs', 'src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error' },
  },
];
