insert into students (student_number, name, group_type)
values
  ('60805', '學生 60805', 'experiment'),
  ('60806', '學生 60806', 'control'),
  ('60807', '學生 60807', 'experiment')
on conflict (student_number) do update
set
  name = excluded.name,
  group_type = excluded.group_type,
  updated_at = now();
