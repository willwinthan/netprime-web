-- New feature permissions: manual course payments, course approval, certificates and PDPA requests.
-- Coordinators confirm transfers by default; the rest stay with admins until granted in the console.
INSERT OR IGNORE INTO role_permissions (role, permission) VALUES ('coordinator', 'payments.manage');
