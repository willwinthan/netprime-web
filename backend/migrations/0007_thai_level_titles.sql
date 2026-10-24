-- Level titles are now stored in Thai (see utils/gamification.ts). Convert rows written before the translation.
UPDATE user_gamification SET title = CASE title
  WHEN 'Code Apprentice' THEN 'ผู้ฝึกหัดโค้ด'
  WHEN 'Cloud Explorer' THEN 'นักสำรวจคลาวด์'
  WHEN 'Edge Specialist' THEN 'ผู้เชี่ยวชาญ Edge'
  WHEN 'Netprime Tech Knight' THEN 'อัศวินเทค Netprime'
  ELSE title END
WHERE title IN ('Code Apprentice', 'Cloud Explorer', 'Edge Specialist', 'Netprime Tech Knight');
