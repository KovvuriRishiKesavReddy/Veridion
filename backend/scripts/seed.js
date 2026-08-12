// Seed script: 1 platform_admin, 2 companies each with
// company_admin/procurement/finance/warehouse, 3 vendors in different
// verification states. Password for every seeded login: password123
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const passwordHash = await bcrypt.hash('password123', 10);

  // wipe existing data (safe for a dev seed run)
  await pool.query(`TRUNCATE invoices, goods_receipt_notes, purchase_orders, quotations,
    requirements, invitations, vendors, users, companies RESTART IDENTITY CASCADE`);

  // platform admin (no company)
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'platform_admin')`,
    ['Platform Admin', 'admin@veridion.dev', passwordHash]
  );

  async function seedCompany(companyName, gstin, slug) {
    // temp creator user first (companies.created_by needs a user, but the
    // user needs a company_id too — insert company with created_by null,
    // then patch)
    const compRes = await pool.query(
      `INSERT INTO companies (name, gstin, address, industry_type) VALUES ($1,$2,$3,$4) RETURNING id`,
      [companyName, gstin, `${companyName} HQ`, 'Construction Materials']
    );
    const companyId = compRes.rows[0].id;

    const adminRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id)
       VALUES ($1,$2,$3,'company_admin',$4) RETURNING id`,
      [`${companyName} Admin`, `admin@${slug}.test`, passwordHash, companyId]
    );
    await pool.query(`UPDATE companies SET created_by=$1 WHERE id=$2`, [adminRes.rows[0].id, companyId]);

    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, company_id) VALUES
       ($1,$2,$3,'procurement',$4), ($5,$6,$7,'finance',$4), ($8,$9,$10,'warehouse',$4)`,
      [
        `${companyName} Procurement`, `proc@${slug}.test`, passwordHash, companyId,
        `${companyName} Finance`, `finance@${slug}.test`, passwordHash,
        `${companyName} Warehouse`, `warehouse@${slug}.test`, passwordHash
      ]
    );
    return companyId;
  }

  await seedCompany('BrightBuild', '27AAAPB1234C1ZV', 'brightbuild');
  await seedCompany('SteelCorp', '29AABPS5678D1ZK', 'steelcorp');

  async function seedVendor(name, email, status) {
    const uRes = await pool.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'vendor') RETURNING id`,
      [name, email, passwordHash]
    );
    await pool.query(
      `INSERT INTO vendors (user_id, company_name, gstin, pan, verification_status, phone_number)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uRes.rows[0].id, name, '27AAAPV1111C1ZV', 'AAAPV1111C', status, '+919999900000']
    );
  }

  await seedVendor('Vendor One Supplies', 'vendor1@test.dev', 'verified');
  await seedVendor('Vendor Two Traders', 'vendor2@test.dev', 'pending');
  await seedVendor('Vendor Three Co', 'vendor3@test.dev', 'rejected');

  console.log('Seed complete. All passwords: password123');
  await pool.end();
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
