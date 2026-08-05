// HTTP response media-type normalization {§http-text-decoding}. Classification
// consumes the WHATWG MIME essence; invalid or absent metadata is not text proof.

import { MIMEType } from "node:util";

const UNKNOWN_RESPONSE_MIMETYPE = "application/octet-stream";

export const responseMimetype = (contentType: string | null): string => {
    if (contentType === null) return UNKNOWN_RESPONSE_MIMETYPE;
    try {
        return new MIMEType(contentType).essence;
    } catch {
        return UNKNOWN_RESPONSE_MIMETYPE;
    }
};
