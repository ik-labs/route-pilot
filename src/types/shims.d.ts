declare module 'better-sqlite3';
declare module 'pdf-parse' {
  export default function pdfParse(data: Buffer | Uint8Array): Promise<{ text: string }>;
}
declare module 'pdf-parse/lib/pdf-parse.js' {
  const fn: (data: Buffer | Uint8Array) => Promise<{ text: string }>;
  export default fn;
}
declare module 'csv-parse/sync' {
  export function parse(input: string, opts?: any): any[];
}
