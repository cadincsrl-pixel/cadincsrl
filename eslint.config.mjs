// @ts-check
import tseslint from 'typescript-eslint'

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      // Variables declaradas pero no usadas: error, excepto las que empiezan con _
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // any explícito: advertencia (a veces necesario con libs externas)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Forzar imports de tipos con 'import type'
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  }
)
