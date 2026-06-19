const { Pool } = require('pg');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'dhihyr2ci',
  api_key: '119441874249666',
  api_secret: 'LGise4-aebSVBvPFywOiV3C7y1Y'
});

const pool = new Pool({
  connectionString: 'postgresql://postgres:semdeRWUNSoEosxYGxiyYYDJONNNFuND@thomas.proxy.rlwy.net:11066/railway',
  ssl: { rejectUnauthorized: false }
});

async function uploadBase64(base64, folder, publicId) {
  const result = await cloudinary.uploader.upload(base64, {
    folder: `showroom/${folder}`,
    public_id: publicId,
    overwrite: true,
    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 80, fetch_format: 'auto' }]
  });
  return result.secure_url;
}

async function migrate() {
  const { rows: products } = await pool.query(
    "SELECT id, brand_id, reference, color, images, image_url FROM products WHERE images != '[]' AND images != '' AND images IS NOT NULL"
  );

  console.log(`\n${products.length} produits avec images à migrer\n`);

  let done = 0, errors = 0;

  for (const p of products) {
    let images = [];
    try { images = JSON.parse(p.images || '[]'); } catch(e) { continue; }

    const base64Images = images.filter(img => img && img.startsWith('data:'));
    if (!base64Images.length) { done++; continue; }

    const urls = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (img && img.startsWith('data:')) {
        try {
          const slug = `${p.reference}-${p.color}-${i}`.replace(/[^a-zA-Z0-9-_]/g, '_').toLowerCase();
          const url = await uploadBase64(img, p.brand_id, slug);
          urls.push(url);
          process.stdout.write('.');
        } catch(e) {
          console.error(`\nErreur upload ${p.reference} img${i}: ${e.message}`);
          urls.push(img); // keep original on error
          errors++;
        }
      } else {
        urls.push(img); // already a URL
      }
    }

    const firstUrl = urls[0] || p.image_url || '';
    await pool.query(
      'UPDATE products SET images=$1, image_url=$2 WHERE id=$3',
      [JSON.stringify(urls), firstUrl, p.id]
    );
    done++;
    console.log(`\n[${done}/${products.length}] ${p.reference} (${p.color}) — ${base64Images.length} images migrées`);
  }

  console.log(`\n✅ Migration terminée: ${done} produits, ${errors} erreurs`);
  await pool.end();
}

migrate().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
