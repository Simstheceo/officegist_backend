-- Fictional demo companies only. is_demo = true so the UI can label them.
-- No fake reviews are seeded: the product's value is real employee data.
BEGIN;

INSERT INTO industries(slug, name) VALUES
  ('logistics','Logistics'), ('technology','Technology'), ('banking','Banking'),
  ('fmcg','FMCG'), ('healthcare','Healthcare'), ('conglomerate','Conglomerate'),
  ('telecoms','Telecoms'), ('oil-and-gas','Oil & Gas'), ('education','Education'), ('consulting','Consulting')
ON CONFLICT DO NOTHING;

INSERT INTO companies(slug, name, industry_id, description, website, employee_band, is_demo) VALUES
  ('abc-logistics','ABC Logistics',(SELECT id FROM industries WHERE slug='logistics'),'Demo company. Fictional.','https://abclogistics.example','1,001-5,000',true),
  ('xyz-technologies','XYZ Technologies',(SELECT id FROM industries WHERE slug='technology'),'Demo company. Fictional.','https://xyztech.example','201-500',true),
  ('example-holdings','Example Holdings',(SELECT id FROM industries WHERE slug='conglomerate'),'Demo company. Fictional.','https://exampleholdings.example','5,000+',true),
  ('ife-foods','Ife Foods',(SELECT id FROM industries WHERE slug='fmcg'),'Demo company. Fictional.','https://ifefoods.example','501-1,000',true),
  ('kora-bank','Kora Bank',(SELECT id FROM industries WHERE slug='banking'),'Demo company. Fictional.','https://korabank.example','1,001-5,000',true),
  ('naija-health-partners','NaijaHealth Partners',(SELECT id FROM industries WHERE slug='healthcare'),'Demo company. Fictional.','https://naijahealth.example','51-200',true)
ON CONFLICT DO NOTHING;

INSERT INTO company_locations(company_id, city, state, is_hq)
SELECT c.id, v.city, v.state, true FROM companies c
JOIN (VALUES ('abc-logistics','Lagos','Lagos'),('xyz-technologies','Lagos','Lagos'),('example-holdings','Abuja','FCT'),
             ('ife-foods','Osogbo','Osun'),('kora-bank','Lagos','Lagos'),('naija-health-partners','Port Harcourt','Rivers')) AS v(slug, city, state)
  ON v.slug = c.slug
WHERE NOT EXISTS (SELECT 1 FROM company_locations l WHERE l.company_id = c.id);

COMMIT;
