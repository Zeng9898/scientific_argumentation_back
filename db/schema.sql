create table if not exists students (
  id bigserial primary key,
  student_number varchar(32) not null unique,
  name varchar(120),
  group_type varchar(16) not null check (group_type in ('experiment', 'control')),
  password_hash text,
  learning_status varchar(16) not null default 'active' check (learning_status in ('active', 'inactive')),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists auth_sessions (
  id bigserial primary key,
  student_id bigint not null references students(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists ai_conversations (
  id bigserial primary key,
  openai_conversation_id text not null unique,
  student_id bigint not null references students(id) on delete cascade,
  surface varchar(32) not null check (surface in ('argument_chat', 'reflection')),
  level_id varchar(64),
  question_index integer,
  prompt_id text,
  group_type_snapshot varchar(16) not null check (group_type_snapshot in ('experiment', 'control')),
  opening_message text,
  last_response_id text,
  last_phase varchar(32),
  last_step integer,
  last_stage varchar(32),
  last_hint_level integer,
  requires_restatement boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_messages (
  id bigserial primary key,
  openai_conversation_id text not null references ai_conversations(openai_conversation_id) on delete cascade,
  student_id bigint not null references students(id) on delete cascade,
  surface varchar(32) not null check (surface in ('argument_chat', 'reflection')),
  question_index integer,
  role varchar(16) not null check (role in ('assistant', 'student', 'system')),
  message_text text not null,
  prompt_id text,
  response_id text,
  phase varchar(32),
  step integer,
  stage varchar(32),
  hint_level integer,
  requires_restatement boolean,
  created_at timestamptz not null default now()
);

create index if not exists idx_students_group_type on students(group_type);
create index if not exists idx_auth_sessions_student_id on auth_sessions(student_id);
create index if not exists idx_ai_conversations_student_surface on ai_conversations(student_id, surface);
create index if not exists idx_ai_conversations_question on ai_conversations(student_id, question_index);
create index if not exists idx_ai_messages_conversation_created on ai_messages(openai_conversation_id, created_at);
create index if not exists idx_ai_messages_student_surface on ai_messages(student_id, surface);
