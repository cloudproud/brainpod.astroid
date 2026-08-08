create table if not exists runs (
  id           bigserial primary key,
  player_name  text not null,
  score        int not null,
  kills        int not null default 0,
  asteroids    int not null default 0,
  survived_ms  int not null,
  region       text,
  is_bot       boolean not null default false,
  ended_at     timestamptz not null default now()
);

create index if not exists runs_score_idx on runs (score desc);
create index if not exists runs_ended_at_idx on runs (ended_at desc);
create index if not exists runs_human_score_idx on runs (score desc) where not is_bot;
