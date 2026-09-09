export type CredentialKey = 'resy-api-key' | 'resy-auth-token' | 'resy-email' | 'resy-password' | 'opentable-token' | 'opentable-auth-cookie' | 'opentable-phone' | 'opentable-cookies' | 'opentable-csrf' | 'opentable-hashes';
export declare function getCredential(key: CredentialKey): Promise<string | null>;
/**
 * Read a credential from the encrypted store only, ignoring environment variables.
 * Used for values the server itself refreshes (e.g. Resy auth tokens), where a
 * stale env var must not shadow the newer stored value.
 */
export declare function getStoredCredential(key: CredentialKey): Promise<string | null>;
export declare function setCredential(key: CredentialKey, value: string): Promise<void>;
export declare function deleteCredential(key: CredentialKey): Promise<boolean>;
export declare function getAllCredentialKeys(): Promise<CredentialKey[]>;
export declare function maskCredential(value: string): string;
export declare function maskEmail(email: string): string;
export interface AuthStatus {
    platform: 'resy' | 'opentable';
    hasApiKey: boolean;
    hasAuthToken: boolean;
    hasLogin: boolean;
    email?: string;
    phone?: string;
}
export declare function getResyAuthStatus(): Promise<AuthStatus>;
export declare function getOpenTableAuthStatus(): Promise<AuthStatus>;
