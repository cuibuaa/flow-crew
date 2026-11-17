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
    files: ['integrations/claude/*.mjs', 'spec/rewrite-hooks-*.test.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { process: 'readonly', URL: 'readonly' } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
