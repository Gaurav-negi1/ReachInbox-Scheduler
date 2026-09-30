/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#effaf1",
          100: "#dcefd9",
          200: "#b9dfb4",
          500: "#3f9d42",
          600: "#2e8b34",
          700: "#24702a",
        },
        onb: {
          900: "#0f1115",
        },
      },
    },
  },
  plugins: [],
};
