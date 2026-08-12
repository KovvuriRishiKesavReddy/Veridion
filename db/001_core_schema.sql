-- Veridion Flow 1 core schema
-- Roles conflate Company Admin under 'company_admin' distinct from 'platform_admin' from day one.

CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  address TEXT,
  industry_type TEXT,
  created_by INTEGER, -- FK to users, added after users exists
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('vendor','company_admin','procurement','finance','warehouse','platform_admin')),
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE companies ADD CONSTRAINT fk_companies_created_by FOREIGN KEY (created_by) REFERENCES users(id);

CREATE TABLE vendors (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  gstin TEXT,
  pan TEXT,
  business_reg_proof_path TEXT,
  bank_account_number TEXT,
  bank_ifsc TEXT,
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK (verification_status IN ('pending','verified','rejected')),
  trust_score NUMERIC,
  phone_number TEXT,
  preferred_notification_channel TEXT NOT NULL DEFAULT 'sms' CHECK (preferred_notification_channel IN ('voice_call','sms','whatsapp','app_only')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  invited_email TEXT NOT NULL,
  invited_role TEXT NOT NULL CHECK (invited_role IN ('procurement','finance','warehouse')),
  invited_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired')),
  token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);

CREATE TABLE requirements (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  quantity NUMERIC NOT NULL,
  unit TEXT,
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotations (
  id SERIAL PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  vendor_id INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  price NUMERIC NOT NULL,
  delivery_days INTEGER NOT NULL,
  notes TEXT,
  ai_rank_score NUMERIC,
  ai_rank_reasoning TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','selected','rejected')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  requirement_id INTEGER NOT NULL REFERENCES requirements(id),
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  agreed_price NUMERIC NOT NULL,
  agreed_quantity NUMERIC NOT NULL,
  agreed_delivery_date DATE,
  status TEXT NOT NULL DEFAULT 'issued',
  po_document_path TEXT,
  fulfillment_status TEXT NOT NULL DEFAULT 'pending' CHECK (fulfillment_status IN ('pending','partially_fulfilled','fulfilled')),
  cumulative_invoiced_quantity NUMERIC NOT NULL DEFAULT 0,
  cumulative_invoiced_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goods_receipt_notes (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  received_quantity NUMERIC NOT NULL,
  received_date DATE NOT NULL,
  warehouse_notes TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  discrepancy_flag BOOLEAN NOT NULL DEFAULT false,
  expected_next_delivery_date DATE,
  next_delivery_notes TEXT
);

CREATE TABLE invoices (
  id SERIAL PRIMARY KEY,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  grn_id INTEGER REFERENCES goods_receipt_notes(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  invoice_number TEXT,
  invoice_amount NUMERIC NOT NULL,
  gst_amount NUMERIC,
  gstin_on_invoice TEXT,
  invoice_file_path TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  due_date DATE,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_company_id ON users(company_id);
CREATE INDEX idx_vendors_user_id ON vendors(user_id);
CREATE INDEX idx_invitations_company_id ON invitations(company_id);
CREATE INDEX idx_requirements_company_id ON requirements(company_id);
CREATE INDEX idx_quotations_requirement_id ON quotations(requirement_id);
CREATE INDEX idx_quotations_vendor_id ON quotations(vendor_id);
CREATE INDEX idx_po_requirement_id ON purchase_orders(requirement_id);
CREATE INDEX idx_po_quotation_id ON purchase_orders(quotation_id);
CREATE INDEX idx_po_vendor_id ON purchase_orders(vendor_id);
CREATE INDEX idx_po_company_id ON purchase_orders(company_id);
CREATE INDEX idx_grn_po_id ON goods_receipt_notes(po_id);
CREATE INDEX idx_invoices_po_id ON invoices(po_id);
CREATE INDEX idx_invoices_grn_id ON invoices(grn_id);
CREATE INDEX idx_invoices_vendor_id ON invoices(vendor_id);
