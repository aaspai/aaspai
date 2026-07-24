function devPort(argv) {
  let port;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--port" || argument === "-p") {
      port = argv[index + 1];
      index += 1;
    } else if (argument.startsWith("--port=")) {
      port = argument.slice("--port=".length);
    } else if (/^-p\d+$/.test(argument)) {
      port = argument.slice(2);
    }
  }

  return /^\d+$/.test(port ?? "") ? port : undefined;
}

export function nextDistDir({
  argv = process.argv,
  configured = process.env.NEXT_DIST_DIR,
  nodeEnv = process.env.NODE_ENV,
  port = process.env.PORT,
} = {}) {
  if (configured) {
    return configured;
  }

  if (nodeEnv !== "development" && !argv.includes("dev")) {
    return ".next";
  }

  const effectivePort = devPort(argv) ?? (/^\d+$/.test(port ?? "") ? port : undefined);
  return effectivePort ? `.next-dev-${effectivePort}` : ".next-dev";
}

export function nextDevTsconfig(distDir) {
  if (!/^\.next-dev(?:-\d+)?$/.test(distDir)) {
    return undefined;
  }

  const path = `${distDir}.tsconfig.json`;
  const contents = `${JSON.stringify(
    {
      extends: "./tsconfig.json",
      compilerOptions: {
        plugins: [{ name: "next" }],
      },
      include: [
        "next-env.d.ts",
        "app/**/*.ts",
        "app/**/*.tsx",
        "components/**/*.ts",
        "components/**/*.tsx",
        "lib/**/*.ts",
        "lib/**/*.tsx",
        `${distDir}/types/**/*.ts`,
      ],
      exclude: ["node_modules", ".next", "dist", "public/templates/files"],
    },
    null,
    2,
  )}\n`;

  return { contents, path };
}
