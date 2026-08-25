-- Keep the four-role MVP vocabulary explicit: SUPER_ADMIN, MERCHANT_ADMIN,
-- MERCHANT_MEMBER, and BUYER.
ALTER TYPE "GlobalRole" RENAME VALUE 'USER' TO 'BUYER';
