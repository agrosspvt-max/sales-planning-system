import { PrismaClient, Role, SeasonStatus } from "@prisma/client";
import bcrypt from "bcryptjs";
import { CANONICAL_PLANNING_PACKS } from "../src/lib/planning-packs";

const prisma = new PrismaClient();

const DEFAULT_PASSWORD = "Password123!";

async function main() {
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  // ---- Users: 1 Super Admin, 2 Regional Managers, 5 Sales Officers ----
  const admin = await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: { name: "System Administrator", username: "admin", passwordHash, role: Role.SUPER_ADMIN },
  });

  const rmData = [
    { name: "Regional Manager North", username: "rm_north" },
    { name: "Regional Manager South", username: "rm_south" },
  ];
  const rms = [];
  for (const rm of rmData) {
    rms.push(
      await prisma.user.upsert({
        where: { username: rm.username },
        update: {},
        create: { ...rm, passwordHash, role: Role.REGIONAL_MANAGER },
      }),
    );
  }

  const soData = [
    { name: "Rahul Patidar", username: "so_rahul" },
    { name: "Amit Sharma", username: "so_amit" },
    { name: "Suresh Verma", username: "so_suresh" },
    { name: "Priya Nair", username: "so_priya" },
    { name: "Vikram Singh", username: "so_vikram" },
  ];
  const sos = [];
  for (const so of soData) {
    sos.push(
      await prisma.user.upsert({
        where: { username: so.username },
        update: {},
        create: { ...so, passwordHash, role: Role.SALES_OFFICER },
      }),
    );
  }

  // ---- Categories & Brands ----
  const categoryNames = ["Insecticide", "Herbicide", "Fungicide", "Bio / Botanical", "Nutrient"];
  const categories: Record<string, string> = {};
  for (const name of categoryNames) {
    const c = await prisma.category.upsert({ where: { name }, update: {}, create: { name } });
    categories[name] = c.id;
  }

  const brandNames = ["Agross Core", "Agross Bio", "Agross Nutri"];
  const brands: Record<string, string> = {};
  for (const name of brandNames) {
    const b = await prisma.brand.upsert({ where: { name }, update: {}, create: { name } });
    brands[name] = b.id;
  }

  // ---- Pack sizes (company default master; the 7 workbook pack columns, in order) ----
  // These are the canonical pack sizes (Section 41 decision): the seasonal workbook maps its
  // 7 pack columns 1:1 onto these. Import matching is space/punctuation-insensitive so the
  // workbook's "25ML" / "10/15 ML" headers resolve onto "25 ML" / "10/15 ML" here.
  const packSizeNames = CANONICAL_PLANNING_PACKS;
  for (let i = 0; i < packSizeNames.length; i++) {
    // Canonical planning packs: pinned order + isPlanning=true (update heals existing rows).
    await prisma.packSize.upsert({
      where: { name: packSizeNames[i] },
      update: { displayOrder: i + 1, isPlanning: true, isActive: true },
      create: { name: packSizeNames[i], displayOrder: i + 1, isPlanning: true },
    });
  }

  // ---- Products (sample from the PRICELIST; nbvPercent stored as a fraction) ----
  const products = [
    { name: "SHOOT-OUT", technicalName: "Chlorpyriphos 50% + Cypermethrin 5% EC", rate: 614.25, nbvPercent: 0.25, category: "Insecticide", brand: "Agross Core" },
    { name: "HERCULES", technicalName: "Emamectin Benzoate 1.9% EC", rate: 1233.05, nbvPercent: 0.25, category: "Insecticide", brand: "Agross Core" },
    { name: "TEJAS", technicalName: "Profenophos 40% + Cypermethrin 4% EC", rate: 596.05, nbvPercent: 0.25, category: "Insecticide", brand: "Agross Core" },
    { name: "MANAGER", technicalName: "Azoxystrobin 4.8% + Chlorothalonil 40% SC", rate: 1178.45, nbvPercent: 0.25, category: "Fungicide", brand: "Agross Core" },
    { name: "MAXX 71", technicalName: "Ammonium Salt of Glyphosate 71% SG", rate: 605.15, nbvPercent: 0.05, category: "Herbicide", brand: "Agross Core" },
    { name: "GLYMO", technicalName: "Glyphosate 41% SL", rate: 373.1, nbvPercent: 0.05, category: "Herbicide", brand: "Agross Core" },
    { name: "ADAM", technicalName: "Botanical Extract", rate: 9253.79, nbvPercent: 0.35, category: "Bio / Botanical", brand: "Agross Bio" },
    { name: "VAJEER", technicalName: "Botanical Extract", rate: 3913.0, nbvPercent: 0.35, category: "Bio / Botanical", brand: "Agross Bio" },
    { name: "ADBHUT", technicalName: "N.P.K Boron and Calcium", rate: 770.0, nbvPercent: 1.0, category: "Nutrient", brand: "Agross Nutri" },
    { name: "FASAL VRADHI KIT", technicalName: "5 in 1 All Rounder", rate: 1540.0, nbvPercent: 1.0, category: "Nutrient", brand: "Agross Nutri" },
  ];
  for (const p of products) {
    await prisma.product.upsert({
      where: { name: p.name },
      update: {},
      create: {
        name: p.name,
        technicalName: p.technicalName,
        rate: p.rate,
        nbvPercent: p.nbvPercent,
        categoryId: categories[p.category],
        brandId: brands[p.brand],
      },
    });
  }

  // ---- Dealers ----
  const dealerData = [
    { name: "Vijasan ksk Rehti", town: "Rehti" },
    { name: "Gothi Fertilizer Itarsi", town: "Itarsi" },
    { name: "DK trc Obedullaganj", town: "Obedullaganj" },
    { name: "Anand ksk Harda", town: "Harda" },
    { name: "Pooja agency Timarni", town: "Timarni" },
    { name: "Rathi and company Vidisha", town: "Vidisha" },
    { name: "Sai agro agency Harda", town: "Harda" },
    { name: "Sonam ksk Bijalgoan", town: "Bijalgoan" },
  ];
  const dealers = [];
  for (const d of dealerData) {
    // Dealers have no unique natural key in the schema; avoid duplicates on re-seed.
    const existing = await prisma.dealer.findFirst({ where: { name: d.name } });
    dealers.push(existing ?? (await prisma.dealer.create({ data: d })));
  }

  // ---- Season: Kharif 2026 (June–November) ----
  const existingSeason = await prisma.season.findUnique({
    where: { name_year: { name: "Kharif", year: 2026 } },
  });
  if (!existingSeason) {
    await prisma.season.create({
      data: {
        name: "Kharif",
        year: 2026,
        startMonth: 6,
        startYear: 2026,
        endMonth: 11,
        endYear: 2026,
        status: SeasonStatus.OPEN,
        months: {
          create: [
            { name: "June", order: 1 },
            { name: "July", order: 2 },
            { name: "August", order: 3 },
            { name: "September", order: 4 },
            { name: "October", order: 5 },
            { name: "November", order: 6 },
          ],
        },
      },
    });
  }

  // ---- RM assignments: so1,so2 -> rm_north; so3,so4 -> rm_south; so5 direct ----
  const from = new Date("2026-04-01");
  const rmPairs: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [2, 1],
    [3, 1],
  ];
  for (const [soIdx, rmIdx] of rmPairs) {
    const officerId = sos[soIdx].id;
    const managerId = rms[rmIdx].id;
    const exists = await prisma.rmAssignment.findFirst({
      where: { officerId, managerId, effectiveTo: null },
    });
    if (!exists) {
      await prisma.rmAssignment.create({ data: { officerId, managerId, effectiveFrom: from } });
    }
  }

  // ---- Dealer assignments: spread dealers across the officers ----
  for (let i = 0; i < dealers.length; i++) {
    const officerId = sos[i % sos.length].id;
    const dealerId = dealers[i].id;
    const exists = await prisma.dealerAssignment.findFirst({
      where: { dealerId, effectiveTo: null },
    });
    if (!exists) {
      await prisma.dealerAssignment.create({ data: { dealerId, officerId, effectiveFrom: from } });
    }
  }

  // ---- A sample system setting & announcement ----
  await prisma.systemSetting.upsert({
    where: { key: "app.name" },
    update: {},
    create: { key: "app.name", value: "Sales Planning System" },
  });
  const hasAnnouncement = await prisma.announcement.findFirst({ where: { title: "Welcome" } });
  if (!hasAnnouncement) {
    await prisma.announcement.create({
      data: { title: "Welcome", body: "Kharif 2026 planning is now open.", audienceRole: null },
    });
  }

  console.log("Seed complete.");
  console.log(`  Super Admin: admin / ${DEFAULT_PASSWORD}`);
  console.log(`  RMs: rm_north, rm_south`);
  console.log(`  SOs: so_rahul, so_amit, so_suresh, so_priya, so_vikram`);
  console.log(`  (all users share the password "${DEFAULT_PASSWORD}")`);
  void admin;
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
