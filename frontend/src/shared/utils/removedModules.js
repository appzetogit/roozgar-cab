// App-module records for retired products (rental, bus, car pooling, shared taxi)
// may still exist in the backend. Hide them from every client surface.
const REMOVED_SERVICE_TYPES = new Set(['rental', 'bus', 'pooling', 'self_drive', 'cab_sharing', 'cab-sharing']);
const REMOVED_NAME_PATTERN = /\b(rentals?|bus(es)?|pool(ing)?|car\s?pool(ing)?|cab\s?sharing|shared\s?taxi|self[\s-]?drive)\b/i;

export const isRemovedModule = (module = {}) => {
  const serviceType = String(module?.service_type || '').trim().toLowerCase();
  const transportType = String(module?.transport_type || '').trim().toLowerCase();
  const name = String(module?.name || module?.title || '').trim();
  return (
    REMOVED_SERVICE_TYPES.has(serviceType) ||
    transportType === 'bus' ||
    transportType === 'pooling' ||
    REMOVED_NAME_PATTERN.test(name)
  );
};

export const filterActiveModules = (list) =>
  Array.isArray(list) ? list.filter((item) => !isRemovedModule(item)) : [];
