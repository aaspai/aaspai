/**
 * @aaspai/crypto — AES-256-GCM authenticated encryption for secrets at rest.
 *
 * Main entry point exports production-safe functions only.
 * For test helpers, import from `@aaspai/crypto/aes`.
 */
export { decrypt, encrypt } from "./aes";
