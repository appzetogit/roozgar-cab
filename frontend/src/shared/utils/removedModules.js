// App-module records for retired products (rental, bus) may still exist in the
// backend. Hide them from every client surface. Car pooling / shared taxi stay live.
const REMOVED_SERVICE_TYPES = new Set(['rental', 'bus', 'self_drive']);
const REMOVED_NAME_PATTERN = /\b(rentals?|bus(es)?|self[\s-]?drive)\b/i;

export const isRemovedModule = (module = {}) => {
  const serviceType = String(module?.service_type || '').trim().toLowerCase();
  const transportType = String(module?.transport_type || '').trim().toLowerCase();
  const name = String(module?.name || module?.title || '').trim();
  return (
    REMOVED_SERVICE_TYPES.has(serviceType) ||
    transportType === 'bus' ||
    REMOVED_NAME_PATTERN.test(name)
  );
};

export const filterActiveModules = (list) =>
  Array.isArray(list) ? list.filter((item) => !isRemovedModule(item)) : [];
