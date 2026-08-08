/**
 * RuntimeProfile — the declared requirements of a harness/execution
 * request, compiled by the execution layer. Providers (e.g. Kubernetes)
 * provision from this profile without ever knowing the adapter name.
 */
export interface RuntimeProfile {
  image?: string;
  resources?: {
    cpu?: number;
    memoryMb?: number;
    diskMb?: number;
    gpu?: number;
  };
  network?: {
    mode: "open" | "restricted";
    allowHosts?: string[];
  };
  setup?: {
    requiredExecutables?: string[];
  };
  labels?: Record<string, string>;
}
