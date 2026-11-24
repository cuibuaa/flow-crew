import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist-rewrite/**',
      'dist-monitor/**',
      'node_modules/**',
    ],
  },
  {
    files: ['rewrite-src/**/*.ts', 'rewrite-monitor/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-constant-condition': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
      'no-useless-assignment': 'warn',
      'prefer-const': 'warn',
      'preserve-caught-error': 'warn',
    },
  },
  {
    files: ['integrations/claude/*.mjs', 'spec/rewrite-hooks-*.test.ts', 'scripts/package-install.mjs', 'spec/native/rewrite-integration-engine.test.ts', 'spec/native/fixtures/public-cli.mjs'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { process: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', console: 'readonly', performance: 'readonly' } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
