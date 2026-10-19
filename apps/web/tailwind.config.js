/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0f9ff',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
        },
        // Role palette base colors (faded per-message in ticket threads).
        role: {
          admin: 'var(--role-admin, #1e3a8a)',
          supervisor: 'var(--role-supervisor, #7c3aed)',
          soporte: 'var(--role-soporte, #16a34a)',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
}