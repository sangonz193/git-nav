/** @satisfies {import("prettier").Config & import("prettier-plugin-tailwindcss").PluginOptions} */
const config = {
  semi: false,
  experimentalTernaries: true,
  plugins: ["prettier-plugin-tailwindcss"],
  tailwindStylesheet: "packages/shadcn/src/styles/globals.css",
  tailwindFunctions: ["cn", "cva", "clsx"],
}

export default config
