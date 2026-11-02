export declare const SECURITY_HEADERS: { key: string; value: string }[];
export declare const HSTS_HEADER: { key: string; value: string };
export declare function buildDocsCsp(scriptHashes: string[]): string;
export declare function readDocsScriptHashes(file: string): string[] | null;
export declare const DOCS_REWRITES: { source: string; destination: string }[];
