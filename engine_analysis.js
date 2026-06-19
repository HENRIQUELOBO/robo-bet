// engine_analysis.js

// Utility to collect analysis entries per method in a consistent API
function createAnalyzer() {
    const entries = {};
    return {
        init(method) {
            if (!entries[method]) entries[method] = { met: false, missing: [] };
            return entries[method];
        },
        addMissing(method, crit) {
            this.init(method);
            entries[method].missing.push(crit);
        },
        setMet(method) {
            this.init(method);
            entries[method].met = true;
            // clear missing when met
            entries[method].missing = [];
        },
        get() {
            return entries;
        }
    };
}

module.exports = { createAnalyzer };

