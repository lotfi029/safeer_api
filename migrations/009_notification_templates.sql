-- 009_notification_templates.sql
-- safeer-backend-code-review.md C17, C23, C27.

-- C23: `{{note}}` was always sent empty (there is no note field on a status
-- change), leaving a blank paragraph in every status mail.
UPDATE mail_templates
SET body_ar = REPLACE(body_ar, '\n\n{{note}}', ''),
    body_en = REPLACE(body_en, '\n\n{{note}}', ''),
    variables = JSON_ARRAY('name', 'reference', 'status', 'link')
WHERE `key` = 'application_status_changed';

-- C17: interview booking, cancellation and a change to a booked slot are
-- confirmed to the applicant. {{date}}/{{time}} are rendered in the
-- association's time zone (src/common/labels.ts); {{location}} may be empty.
INSERT IGNORE INTO mail_templates (`key`, name_ar, name_en, subject_ar, subject_en, body_ar, body_en, variables, is_enabled, updated_by) VALUES
  ('interview_booked', 'تأكيد موعد المقابلة', 'Interview booked',
   'تأكيد موعد مقابلتك — {{reference}}', 'Your interview is booked — {{reference}}',
   'مرحبًا {{name}}،\n\nتم حجز موعد مقابلتك لطلب المنحة رقم **{{reference}}**:\n\n- **التاريخ:** {{date}}\n- **الوقت:** {{time}}\n- **المكان:** {{location}}\n\nيمكنك مراجعة الموعد أو إلغاؤه من بوابة الطالب:\n\n[{{link}}]({{link}})',
   'Hello {{name}},\n\nYour interview for scholarship application **{{reference}}** is booked:\n\n- **Date:** {{date}}\n- **Time:** {{time}}\n- **Location:** {{location}}\n\nYou can review or cancel it from the student portal:\n\n[{{link}}]({{link}})',
   JSON_ARRAY('name', 'reference', 'date', 'time', 'location', 'link'), 1, NULL),
  ('interview_cancelled', 'إلغاء موعد المقابلة', 'Interview cancelled',
   'تم إلغاء موعد مقابلتك — {{reference}}', 'Your interview was cancelled — {{reference}}',
   'مرحبًا {{name}}،\n\nتم إلغاء موعد مقابلتك لطلب المنحة رقم **{{reference}}** ({{date}}، {{time}}).\n\nيمكنك اختيار موعد جديد من بوابة الطالب:\n\n[{{link}}]({{link}})',
   'Hello {{name}},\n\nYour interview for scholarship application **{{reference}}** ({{date}}, {{time}}) was cancelled.\n\nYou can choose a new time from the student portal:\n\n[{{link}}]({{link}})',
   JSON_ARRAY('name', 'reference', 'date', 'time', 'link'), 1, NULL),
  ('interview_updated', 'تعديل موعد المقابلة', 'Interview changed',
   'تغيّر موعد مقابلتك — {{reference}}', 'Your interview has changed — {{reference}}',
   'مرحبًا {{name}}،\n\nتم تعديل موعد مقابلتك لطلب المنحة رقم **{{reference}}**، والموعد الجديد:\n\n- **التاريخ:** {{date}}\n- **الوقت:** {{time}}\n- **المكان:** {{location}}\n\nللمراجعة أو الإلغاء:\n\n[{{link}}]({{link}})',
   'Hello {{name}},\n\nYour interview for scholarship application **{{reference}}** has changed. The new details:\n\n- **Date:** {{date}}\n- **Time:** {{time}}\n- **Location:** {{location}}\n\nTo review or cancel it:\n\n[{{link}}]({{link}})',
   JSON_ARRAY('name', 'reference', 'date', 'time', 'location', 'link'), 1, NULL),
  -- C27: newsletter double opt-in.
  ('newsletter_confirm', 'تأكيد الاشتراك في النشرة', 'Confirm newsletter subscription',
   'أكّد اشتراكك في نشرة جمعية سفير', 'Confirm your Safeer newsletter subscription',
   'مرحبًا،\n\nتلقينا طلبًا لاشتراك هذا البريد في النشرة الإخبارية لجمعية سفير الدعوية. لتأكيد الاشتراك اضغط على الرابط التالي:\n\n[{{link}}]({{link}})\n\nإذا لم تطلب ذلك، تجاهل هذه الرسالة ولن يُضاف بريدك.',
   'Hello,\n\nWe received a request to subscribe this address to the Safeer Association newsletter. To confirm, follow this link:\n\n[{{link}}]({{link}})\n\nIf you did not ask for this, ignore this message and nothing will be added.',
   JSON_ARRAY('link'), 1, NULL);

INSERT IGNORE INTO sms_templates (`key`, name_ar, name_en, body_ar, body_en, variables, is_enabled, updated_by) VALUES
  ('interview_booked', 'تأكيد موعد المقابلة', 'Interview booked',
   'جمعية سفير: تم حجز مقابلتك لطلب {{reference}} يوم {{date}} الساعة {{time}}.',
   'Safeer: your interview for application {{reference}} is booked for {{date}} at {{time}}.',
   JSON_ARRAY('reference', 'date', 'time'), 1, NULL),
  ('interview_cancelled', 'إلغاء موعد المقابلة', 'Interview cancelled',
   'جمعية سفير: تم إلغاء مقابلتك لطلب {{reference}} ({{date}} {{time}}). اختر موعدًا جديدًا من بوابة الطالب.',
   'Safeer: your interview for application {{reference}} ({{date}} {{time}}) was cancelled. Choose a new time in the student portal.',
   JSON_ARRAY('reference', 'date', 'time'), 1, NULL),
  ('interview_updated', 'تعديل موعد المقابلة', 'Interview changed',
   'جمعية سفير: تغيّر موعد مقابلتك لطلب {{reference}} إلى {{date}} الساعة {{time}}.',
   'Safeer: your interview for application {{reference}} moved to {{date}} at {{time}}.',
   JSON_ARRAY('reference', 'date', 'time'), 1, NULL);
