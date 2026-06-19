// engine_analysis.js

// Utility to collect analysis entries per method in a consistent API
function createAnalyzer() {
    const entries = {};
    return {
        init(method) {
            if (!entries[method]) entries[method] = { met: false, missing: [], expected: [], satisfied: [] };
            return entries[method];
        },
        // crit: key string; optional value and label improve display (e.g. 'ataquesCasa<6', value=4)
        addMissing(method, crit, value = null, label = null) {
            this.init(method);
            const display = label ? `${label}${value !== null ? `: ${value}` : ''}` : `${crit}${value !== null ? ` (valor: ${value})` : ''}`;
            // record the criterion as expected (avoid duplicates by key)
            if (!entries[method].expected.some(e => e.startsWith(crit))) entries[method].expected.push(display);
            // avoid duplicated missing reasons (by key)
            if (!entries[method].missing.some(m => m.startsWith(crit))) entries[method].missing.push(display);
        },
        // Record an expected criterion without marking it as missing
        addExpected(method, crit, value = null, label = null) {
            this.init(method);
            const display = label ? `${label}${value !== null ? `: ${value}` : ''}` : `${crit}${value !== null ? ` (valor: ${value})` : ''}`;
            if (!entries[method].expected.some(e => e.startsWith(crit))) entries[method].expected.push(display);
        },
        setMet(method) {
            this.init(method);
            entries[method].met = true;
            // when met, record what criteria were expected as satisfied copy
            entries[method].satisfied = Array.from(new Set(entries[method].expected));
            // clear missing when met
            entries[method].missing = [];
        },
        get() {
            return entries;
        }
    };
}

module.exports = { createAnalyzer };
