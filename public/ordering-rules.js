(function(root, factory) {
  const rules = factory();
  if (typeof module === 'object' && module.exports) module.exports = rules;
  else root.OrderingRules = rules;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  function minimum(brand) {
    const n = Number(brand?.min_per_reference_override ?? brand?.min_per_reference ?? 1);
    return Number.isSafeInteger(n) && n > 0 ? n : 1;
  }
  function key(brand, product, color, size) {
    return JSON.stringify([String(brand || ''), String(product || ''), String(color || ''), String(size || '')]);
  }
  function referenceKey(line) {
    return JSON.stringify([line.brand_id, line.reference || line.product_id]);
  }
  function aggregate(lines, quantityField = 'qty') {
    const groups = new Map();
    for (const line of lines) {
      const k = referenceKey(line);
      groups.set(k, (groups.get(k) || 0) + Number(line[quantityField] || 0));
    }
    return groups;
  }
  function step(quantity, delta, min) {
    if (delta > 0) return quantity === 0 ? min : quantity + 1;
    return quantity <= min ? 0 : quantity - 1;
  }
  function catalogIssue(product, line, { allocated = 0, requireSize = false } = {}) {
    if (!product || ((product.active === 0 || product.active === false) && !product.is_sample)) return 'unavailable';
    const quantity = Number(line.quantity ?? line.qty);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000) return 'quantity';
    const size = String(line.size || '');
    const sizes = String(product.sizes || '').split(',').map(s => s.trim()).filter(Boolean);
    if ((size || requireSize) && sizes.length && !sizes.includes(size)) return 'size';
    const color = String(line.variant_color ?? line.color ?? '');
    let variants = [];
    try { variants = typeof product.variants === 'string' ? JSON.parse(product.variants || '[]') : product.variants || []; } catch (_) {}
    if (color && color !== product.color && !variants.some(v => v.color === color)) return 'color';
    if (product.stock_enabled && product.stock_qty != null && allocated + quantity > Number(product.stock_qty)) return 'stock';
    return null;
  }
  function normalize(saved, brands = []) {
    const result = Object.create(null);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return result;
    for (const line of Object.values(saved)) {
      if (!line || typeof line !== 'object' || !line.brand_id || !line.product_id) continue;
      const qty = Number(line.qty);
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 100000) continue;
      const normalized = { ...line, color: String(line.color || line.variant_color || ''), size: String(line.size || ''), qty };
      const k = key(line.brand_id, line.product_id, normalized.color, normalized.size);
      if (result[k]) result[k].qty += qty;
      else result[k] = normalized;
    }
    const totals = aggregate(Object.values(result));
    for (const line of Object.values(result)) {
      const k = referenceKey(line);
      const min = minimum(brands.find(b => b.id === line.brand_id));
      const total = totals.get(k);
      if (total < min) { line.qty += min - total; totals.set(k, min); }
    }
    return result;
  }
  return { minimum, key, referenceKey, aggregate, step, normalize, catalogIssue };
});
