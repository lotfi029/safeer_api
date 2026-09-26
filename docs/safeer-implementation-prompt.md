# Prompt لتنفيذ موقع ولوحة تحكم جمعية سفير الدعوية

> انسخ ما تحت الفاصل كاملاً وأعطه لـ Claude Code في مجلد `D:\Freelance\Safeer` مع إرفاق `docs/safeer-design-spec.md`.

---

أنت تنفّذ موقعاً جديداً ولوحة تحكم لـ **جمعية سفير الدعوية** (جمعية سعودية غير ربحية ترعى طلاب المنح الدوليين في الجامعات السعودية) محل موقعها الحالي على WordPress.

## المدخلات

- `docs/safeer-design-spec.md` — مواصفات التصميم الكاملة: الألوان، الخطوط، المكونات، الحركة، وقائمة الشاشات. اقرأه أولاً بالكامل والتزم به حرفياً في القيم (hex، الأحجام، الاستدارات، الارتفاعات).
- النموذج المرئي: Design artifact بعنوان «Safeer — Redesign & Admin Prototype» — ٣٢ لوحة. إن توفّر لك، عاين اللوحة المقابلة لكل شاشة قبل بنائها.
- الموقع الحالي للمحتوى فقط: https://safeer-sa.org/ — **لا تنقل منه أي محتوى إنجليزي تجريبي** (مقالات كوفيد، تصنيفات Neurology/Cardiology/Pathology، بطاقات Drone Service وPhotography، صفحات doctor/appointment/cart).

## بنية المستودعات

أنشئ مجلدين منفصلين في جذر المشروع، لكل منهما مستودع Git مستقل:

```
D:\Freelance\Safeer\
  docs\          ← المواصفات وهذا الملف — لا يُدفع إلى أي مستودع
  frontend\      ← مستودع مستقل
  backend\       ← مستودع مستقل
```

أضف `docs/` إلى `.gitignore` في كليهما. لا تضع أي ملف توثيق داخل `frontend/` أو `backend/` غير `README.md` تقني قصير.

## التقنيات

**frontend** — Next.js 15 (App Router) + TypeScript + Tailwind CSS 4 + next-intl.
- توجيه بلغتين `/[locale]` مع `ar` افتراضية و `dir="rtl"`، و `en` بـ `dir="ltr"`.
- خطوط: `IBM Plex Sans Arabic` و `IBM Plex Sans` عبر `next/font/google` بـ `display: swap`.
- رموز التصميم كمتغيرات CSS على `:root` وكـ tokens في `tailwind.config`، بالأسماء الواردة في المواصفات (`--primary`, `--secondary`, `--surface`, `--text-muted` …). لا ألوان خارج اللوحة.
- الحركة: `framer-motion` أو IntersectionObserver مع `prefers-reduced-motion` محترماً في كل تأثير.
- منطق RTL أصيل: استخدم خصائص CSS المنطقية (`padding-inline-start`, `margin-inline-end`) لا `left/right`.
- إمكانية الوصول: عناصر `<button>` و `<a href>` و `<label>` حقيقية، `aria-label` لكل زر أيقوني، تباين نص ≥ 4.5:1، حد لمس ≥ 44px.

**backend** — NestJS + TypeScript + PostgreSQL + Prisma.
- مصادقة لوحة التحكم: JWT + refresh، وصلاحيات بالأدوار الأربعة الواردة في المواصفات (مدير عام، مراجع طلبات، محرر محتوى، دعم ومراسلات) عبر Guards.
- مصادقة بوابة الطالب: رمز OTP لمرة واحدة عبر SMS/بريد، صالح ١٠ دقائق، بلا كلمات مرور.
- رفع الملفات إلى S3-compatible مع روابط موقّعة قصيرة العمر؛ لا تُخزَّن مستندات الطلاب في مسار عام.
- كل حقل نصي قابل للنشر له عمودان `*_ar` و `*_en`؛ الرد على الطلب يعود للعربية إذا كانت الإنجليزية فارغة.

## نماذج البيانات (الحد الأدنى)

```
Page(slug, title_ar/en, status, sections[])
PageSection(pageId, type, order, visible, data_ar/en jsonb)
Post(slug, title_ar/en, excerpt, body_ar/en, categoryId, coverImage, status, publishedAt)
Category(slug, name_ar/en)
WorkArea(order, visible, icon, title_ar/en, items[])
BoardMember(order, name, role, type: BOARD|EXECUTIVE, photo, bio_ar/en)
Testimonial(author, body_ar/en, status: PENDING|PUBLISHED|HIDDEN, featured)
TestimonialTheme(order, title_ar/en, body_ar/en)
Partner(order, name, category, logo, url)
Document(title_ar/en, section, file, size, publishedAt, status)
ContactMessage(name, phone, email, subject, body, status: UNREAD|READ|ARCHIVED, reply)
ScholarshipApplication(ref, firstName, middleName, lastName, dob, gender, nationality,
  nationalId, phone, email, currentJob, university, degree, about,
  status: NEW|UNDER_REVIEW|DOCS_MISSING|INTERVIEW|ACCEPTED|REJECTED, assigneeId)
ApplicationDocument(applicationId, type, file, status: PENDING|ACCEPTED|REJECTED, rejectionReason)
ApplicationNote(applicationId, authorId, body)   // داخلية، لا يراها الطالب
ApplicationEvent(applicationId, type, actorId, createdAt)  // سجل الإجراءات
User(name, email, role, status)
SiteSettings(name_ar/en, phone, email, address_ar/en, footerBlurb_ar/en, social{})
```

`ref` بصيغة `SA-YYYY-NNNNN`.

## ترتيب التنفيذ

1. المستودعان + رموز التصميم + تخطيط RTL + الشريط العلوي والتذييل + مبدّل اللغة.
2. الصفحات العامة الثابتة: الرئيسية، من نحن، مجلس الإدارة، مجالات عملنا، منح الوافدين، قالوا عنا، شركاؤنا، التراخيص والسياسات، تواصل معنا — بالمحتوى العربي الحقيقي الوارد في المواصفات.
3. الأخبار + صفحة الخبر + التصنيفات.
4. نموذج طلب المنحة بثلاث خطوات + الحفظ التلقائي + رفع المستندات.
5. بوابة الطالب: OTP، حالة الطلب، المستندات.
6. لوحة التحكم: المصادقة والأدوار، ثم طلبات المنح ومراجعتها، ثم الرسائل، ثم وحدات المحتوى، ثم المستخدمون والإعدادات.
7. الوضع الداكن، حركة التمرير، SEO (عناوين، وصف، بيانات منظمة `NGO`، خريطة موقع، `hreflang`).

## قواعد صارمة

- **لا محتوى مخترع**: أي رقم أو اسم أو تاريخ غير موجود في المواصفات يبقى `[...]` أو يُقرأ من قاعدة البيانات. لا تخترع أرقام مستفيدين أو أسماء شركاء أو شهادات.
- **الشعار**: النموذج يستخدم إعادة بناء SVG تقريبية. اطلب ملف الشعار الرسمي واستبدله؛ لا تسلّم بالشعار التقريبي.
- **الصور**: مواضع معنونة `[صورة: ...]` حتى تصل الصور الحقيقية.
- **الرقم الحقيقي الوحيد المعلن حالياً**: «٢ أعوام من الخبرة».
- **المحتوى الحساس**: بيانات الطلاب ومستنداتهم لا يصل إليها إلا «مدير عام» و«مراجع طلبات».
- اكتب اختبارات للـ API (Jest + supertest) على الأقل لمسارات الطلبات والصلاحيات.
- التزم بمعايير الوصول في كل شاشة، ولا تستخدم `div` قابلاً للنقر.

## معيار الإنجاز

- كل شاشة في النموذج لها مقابل يعمل.
- `npm run build` ينجح في المشروعين بلا تحذيرات TypeScript.
- تدقيق Lighthouse ≥ 95 في Accessibility و Best Practices على الصفحة الرئيسية.
- الموقع كامل التصفح بالعربية RTL على عرض 390px و1440px.
- `docs/` غير مدفوع في أي من المستودعين.

ابدأ بخطة موجزة للخطوة ١ ثم نفّذها، وتوقّف لعرض النتيجة قبل الانتقال للخطوة التالية.
