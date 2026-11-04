'use strict';
// Shared definitions for owner and territory-scoped agent dashboards. These
// amounts describe recorded active orders, never invoices or cash receipts.
const ACTIVE_ORDER_STATUSES=Object.freeze(['confirmed','validated','in_production','shipped']);
function alias(value) {
  if(!/^[a-z][a-z0-9_]*$/i.test(value))throw new Error('Invalid internal SQL alias');
  return value;
}
function activeOrdersSql(name='o') {
  return `${alias(name)}.status IN ('confirmed','validated','in_production','shipped')`;
}
function proposedSelectionsSql(name='a') {
  const a=alias(name);
  // 'sent' is a recorded proposal state: historical rows do not prove that an
  // email was accepted, delivered or read. Drafts/unknown states are excluded.
  return `${a}.status='sent' AND NOT COALESCE(${a}.is_template,false)`;
}
function selectionMetrics(row) {
  const proposed=Number(row.total)||0,accepted=Number(row.confirmed)||0;
  const rate=proposed?Math.round(accepted/proposed*100):0;
  return {selections_proposed:proposed,selections_accepted:accepted,selection_acceptance_rate:rate,
    selection_metric:'recorded_proposal_acceptance',
    // Existing clients keep their keys, using the corrected same cohort.
    selections_total:proposed,selections_confirmed:accepted,conversion_rate:rate};
}
// Scope is a fixed internal enum, never a caller-provided SQL fragment. Agent
// grants remain exact (brand,country) pairs rather than independent IN lists.
function dashboardScopeSql(scope) {
  if(scope==='all')return 'TRUE';
  if(scope==='brand')return 'o.brand_id=$1';
  if(scope==='agent')return require('./agent-scopes').scopeSql('o.brand_id','UPPER(TRIM(o.client_country))');
  throw new Error('Invalid dashboard metric scope');
}
function dashboardWindowSql() {
  return "o.created_at>=date_trunc('month',NOW())-INTERVAL '5 months' AND o.created_at<=NOW()";
}
function revenueChartSql(scope='all') {
  return `WITH months AS (
      SELECT generate_series(date_trunc('month',NOW())-INTERVAL '5 months',date_trunc('month',NOW()),INTERVAL '1 month') AS month_date
    ), totals AS (
      SELECT to_char(o.created_at,'YYYY-MM') AS month_key,COALESCE(SUM(ol.quantity*ol.unit_price),0) AS total
      FROM orders o LEFT JOIN order_lines ol ON ol.order_id=o.id
      WHERE ${activeOrdersSql('o')} AND ${dashboardWindowSql()} AND ${dashboardScopeSql(scope)}
      GROUP BY to_char(o.created_at,'YYYY-MM')
    )
    SELECT to_char(m.month_date,'YYYY-MM') AS month_key,COALESCE(t.total,0) AS total
    FROM months m LEFT JOIN totals t ON t.month_key=to_char(m.month_date,'YYYY-MM') ORDER BY m.month_date`;
}
function topProductsSql(scope='all') {
  return `SELECT p.id,p.reference,p.description,p.color,b.name AS brand_name,
      COALESCE(SUM(ol.quantity),0) AS qty,COALESCE(SUM(ol.quantity*ol.unit_price),0) AS revenue
    FROM order_lines ol JOIN orders o ON o.id=ol.order_id
    JOIN products p ON p.id=ol.product_id AND p.brand_id=o.brand_id
    JOIN brands b ON b.id=o.brand_id
    WHERE ${activeOrdersSql('o')} AND ${dashboardWindowSql()} AND ${dashboardScopeSql(scope)}
    GROUP BY p.id,b.name ORDER BY qty DESC,revenue DESC,p.id LIMIT 8`;
}
function metricNumber(value) {
  const number=Number(value);
  if(!Number.isFinite(number))throw new Error('Invalid numeric commercial metric');
  return number;
}
function formatRevenueChart(rows,lang='fr') {
  const labels=new Intl.DateTimeFormat(lang==='en'?'en-GB':'fr-FR',{month:'short',timeZone:'UTC'});
  return rows.map(row=>{
    // The key comes from PostgreSQL's calendar. Never parse a DB TIMESTAMP as
    // a local JS Date and convert it to UTC, which can move it to another month.
    if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month_key))throw new Error('Invalid commercial metric month');
    const [year,month]=row.month_key.split('-').map(Number);
    return {month_key:row.month_key,month:labels.format(new Date(Date.UTC(year,month-1,15))),total:metricNumber(row.total)};
  });
}
function formatTopProducts(rows) {
  return rows.map(row=>({...row,qty:metricNumber(row.qty),revenue:metricNumber(row.revenue)}));
}
module.exports={ACTIVE_ORDER_STATUSES,activeOrdersSql,proposedSelectionsSql,selectionMetrics,
  revenueChartSql,topProductsSql,formatRevenueChart,formatTopProducts};
