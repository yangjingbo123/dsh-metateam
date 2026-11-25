/** Reject prototype-bearing argument containers and require a JSON object. */
export function object(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected an object');
    return value;
}
export function text(value, label, optional = false) {
    if (optional && value === undefined)
        return '';
    if (typeof value !== 'string' || (!optional && !value.trim()))
        throw new Error(`${label} must be nonempty text`);
    if (value.length > 200_000)
        throw new Error(`${label} exceeds the configured text limit`);
    return value;
}
export function strings(value, label) {
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string'))
        throw new Error(`${label} must be a string array`);
    return value;
}
export function identifier(value) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value))
        throw new Error(`Invalid identifier: ${value}`);
    return value;
}
