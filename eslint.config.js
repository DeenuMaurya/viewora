module.exports = [
  {
    ignores: ["node_modules/**", ".npm-cache/**", "backend/data/**", "backend/uploads/**"]
  },
  {
    files: ["backend/**/*.js", "test/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        Buffer: "readonly",
        Blob: "readonly",
        console: "readonly",
        __dirname: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        Headers: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "error"
    }
  },
  {
    files: ["frontend/public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: {
        BABYLON: "readonly",
        document: "readonly",
        performance: "readonly",
        window: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "error"
    }
  }
];
