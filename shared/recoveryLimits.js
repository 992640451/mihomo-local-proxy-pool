// AES-GCM preserves payload length; base64 expands it by 4/3.
// Reserve additional space for the file envelope and HTTP request wrapper.
export const RECOVERY_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024
export const RECOVERY_MAX_FILE_BYTES = 33 * 1024 * 1024
export const RECOVERY_MAX_REQUEST_BYTES = 34 * 1024 * 1024
