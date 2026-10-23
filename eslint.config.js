import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const filesystemMutations = ['appendFile', 'chmod', 'chown', 'close', 'copyFile', 'cp', 'fchmod', 'fchown',
  'ftruncate', 'futimes', 'lchmod', 'lchown', 'link', 'lutimes', 'mkdir', 'mkdtemp', 'open', 'rename', 'rm',
  'rmdir', 'symlink', 'truncate', 'unlink', 'utimes', 'write', 'writeFile', 'writev', 'createWriteStream'];

const filesystemSyntax = [{
  selector: 'ImportExpression[source.value=/^(node:)?fs(\\/promises)?$/]',
  message: 'Import engine-fs for runtime filesystem access.',
}, {
  selector: 'CallExpression[arguments.0.value=/^(node:)?fs(\\/promises)?$/]',
  message: 'Import engine-fs for runtime filesystem access.',
}];
const databaseSyntax = [{
  selector: 'ImportDeclaration[source.value="node:sqlite"], ImportExpression[source.value="node:sqlite"], CallExpression[arguments.0.value="node:sqlite"]',
  message: 'Native database access belongs in the audited database providers.',
}];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'ui/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['fs', 'fs/promises', 'node:fs/promises', {
          name: 'node:fs',
          importNames: [...filesystemMutations, ...filesystemMutations.map(name => `${name}Sync`), 'promises'],
          message: 'Engine mutations must use engine-fs so stage integrity records parent writes.',
        }],
      }],
      'no-restricted-syntax': ['error', ...filesystemSyntax, ...databaseSyntax],
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
    files: ['src/engine-fs.ts', 'src/engine-integrity.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['src/run-index.ts'],
    rules: { 'no-restricted-syntax': ['error', ...filesystemSyntax] },
  },
);
