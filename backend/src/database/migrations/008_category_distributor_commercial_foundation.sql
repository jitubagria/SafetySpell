-- QR lifecycle foundation: category is a master record, distributors hold sellable stock,
-- and commercial tables exist as a schema skeleton only. No consent or public-scan query
-- is changed by this migration.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'distributor';

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text NOT NULL,
  color text NOT NULL DEFAULT '#1f2937',
  qr_design_config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qr_design_config) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO categories(key, name, color) VALUES
  ('medical', 'Medical', '#b91c1c'),
  ('elderly', 'Elderly', '#047857'),
  ('kids', 'Kids', '#2563eb'),
  ('deaf_mute', 'Deaf-mute', '#7c3aed'),
  ('disability', 'Disability', '#0f766e'),
  ('epilepsy_cardiac', 'Epilepsy / cardiac', '#be123c')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('hospital', 'society', 'ngo', 'business')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE distributors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  parent_distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT;
ALTER TABLE users ADD COLUMN tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT;

CREATE TABLE distributor_allowed_categories (
  distributor_id uuid NOT NULL REFERENCES distributors(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (distributor_id, category_id)
);
CREATE TABLE tenant_allowed_categories (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  PRIMARY KEY (tenant_id, category_id)
);

CREATE TABLE sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('csr', 'ngo', 'government', 'hospital')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE price_books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, currency text NOT NULL DEFAULT 'INR',
  valid_from timestamptz, valid_to timestamptz, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), price_book_id uuid NOT NULL REFERENCES price_books(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT, level text NOT NULL CHECK (level IN ('base', 'distributor', 'retailer', 'mrp')),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0), billing_type text NOT NULL CHECK (billing_type IN ('one_time', 'monthly', 'annual', 'free', 'sponsored')),
  min_qty integer NOT NULL DEFAULT 1 CHECK (min_qty > 0), tax_rate numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);
CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT,
  level text NOT NULL CHECK (level IN ('distributor', 'retailer')), type text NOT NULL CHECK (type IN ('margin', 'percent', 'flat')),
  value numeric(12,2) NOT NULL CHECK (value >= 0), valid_from timestamptz, valid_to timestamptz
);
CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), buyer_tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  buyer_distributor_id uuid REFERENCES distributors(id) ON DELETE RESTRICT, price_book_id uuid REFERENCES price_books(id) ON DELETE RESTRICT,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0), tax_total numeric(12,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')), created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(buyer_tenant_id, buyer_distributor_id) = 1)
);
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT, quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0)
);
