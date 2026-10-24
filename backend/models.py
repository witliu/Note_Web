from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Revision(StrictModel):
    revision: int = Field(ge=1)


class EntryInput(StrictModel):
    title: str = Field(default='', max_length=100)
    body: str = Field(default='', max_length=100000)
    date: date
    place: str = Field(default='', max_length=200)
    tags: list[Annotated[str, Field(min_length=1, max_length=40)]] = Field(default_factory=list, max_length=20)
    story: UUID | None = None
    attachment_ids: list[UUID] = Field(default_factory=list, max_length=50)

    @field_validator('attachment_ids')
    @classmethod
    def unique_attachments(cls, value):
        if len(value) != len(set(value)):
            raise ValueError('附件不能重复')
        return value

    @field_validator('title', 'body', 'place')
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @field_validator('tags')
    @classmethod
    def clean_tags(cls, tags):
        return list(dict.fromkeys(t.strip() for t in tags if t.strip()))


class PublishInput(EntryInput):
    # Chosen once by the client; a lost HTTP response cannot create duplicate entries.
    id: UUID
    revision: int = Field(default=0, ge=0)
    draft_id: UUID | None = None
    draft_revision: int | None = Field(default=None, ge=1)

    @model_validator(mode='after')
    def require_body(self):
        if not self.body and not self.attachment_ids:
            raise ValueError('请填写正文或添加至少一个已上传完成的附件')
        if self.draft_id is not None and self.draft_revision is None:
            raise ValueError('缺少草稿版本')
        return self


class StoryInput(StrictModel):
    name: str = Field(min_length=1, max_length=60)
    description: str = Field(default='', max_length=5000)

    @field_validator('name', 'description')
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @model_validator(mode='after')
    def require_name(self):
        if not self.name:
            raise ValueError('故事名称不能为空')
        return self


class DraftInput(EntryInput):
    revision: int = Field(default=0, ge=0)
    editing_id: UUID | None = None
    editing_revision: int | None = Field(default=None, ge=1)
    entry_id: UUID


class AnniversaryInput(StrictModel):
    id: UUID
    revision: int = Field(default=0, ge=0)
    name: str = Field(min_length=1, max_length=60)
    kind: Literal['anniversary', 'birthday', 'other'] = 'anniversary'
    calendar: Literal['solar', 'unconfirmed']
    month: int = Field(ge=1, le=12)
    day: int = Field(ge=1, le=31)
    start_year: int | None = Field(default=None, ge=1, le=9998)
    remind_days: int = Field(default=0, ge=0, le=30)
    enabled: bool = True
    note: str = Field(default='', max_length=2000)

    @field_validator('name', 'note')
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @model_validator(mode='after')
    def validate_anniversary(self):
        if not self.name:
            raise ValueError('请填写纪念日名称')
        try:
            date(self.start_year or 2000, self.month, self.day)
        except ValueError:
            raise ValueError('日期无效，请检查月份、日期和起始年份')
        return self


class WishInput(StrictModel):
    id: UUID
    revision: int = Field(default=0, ge=0)
    title: str = Field(min_length=1, max_length=100)
    note: str = Field(default='', max_length=5000)
    target_date: date | None = None

    @field_validator('title', 'note')
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @model_validator(mode='after')
    def require_title(self):
        if not self.title:
            raise ValueError('写下想一起完成的事吧')
        return self


class WishStatus(Revision):
    done: bool


class FootprintInput(StrictModel):
    id: UUID
    revision: int = Field(default=0, ge=0)
    name: str = Field(min_length=1, max_length=100)
    province: str = Field(default='', max_length=60)
    longitude: float = Field(ge=72, le=136)
    latitude: float = Field(ge=2, le=55)
    coordinate_system: Literal['datav_geojson'] = 'datav_geojson'
    visited_on: date | None = None
    note: str = Field(default='', max_length=5000)

    @field_validator('name', 'province', 'note')
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @model_validator(mode='after')
    def require_name(self):
        if not self.name:
            raise ValueError('给这个地点起个名字吧')
        return self


class AccountInput(StrictModel):
    username: str = Field(min_length=3, max_length=32, pattern=r'^[a-zA-Z0-9][a-zA-Z0-9_.-]*$')
    display_name: str = Field(min_length=1, max_length=30)
    password: str = Field(min_length=8, max_length=128)

    @field_validator('username')
    @classmethod
    def normalize_username(cls, value):
        return value.lower()

    @field_validator('display_name')
    @classmethod
    def clean_display_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('请填写显示名字')
        return value


class AccountSetup(StrictModel):
    accounts: list[AccountInput] = Field(min_length=2, max_length=2)

    @model_validator(mode='after')
    def different_accounts(self):
        if self.accounts[0].username == self.accounts[1].username:
            raise ValueError('两个人的登录名需要不同')
        return self


class LoginInput(StrictModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class QuestionOption(StrictModel):
    id: UUID
    text: str = Field(min_length=1, max_length=300)

    @field_validator('text')
    @classmethod
    def clean_text(cls, value):
        value = value.strip()
        if not value:
            raise ValueError('选项内容不能为空')
        return value


class QuestionInput(StrictModel):
    id: UUID
    body: str = Field(min_length=1, max_length=3000)
    kind: Literal['single', 'multiple'] = 'single'
    options: list[QuestionOption] = Field(min_length=2, max_length=6)
    correct_option_ids: list[UUID] = Field(min_length=1, max_length=6)
    explanation: str = Field(default='', max_length=3000)

    @field_validator('body', 'explanation')
    @classmethod
    def clean_text(cls, value):
        return value.strip()

    @model_validator(mode='after')
    def validate_question(self):
        option_ids = {option.id for option in self.options}
        if not self.body:
            raise ValueError('请填写题目')
        if len(option_ids) != len(self.options) or len({o.text for o in self.options}) != len(self.options):
            raise ValueError('选项编号和内容不能重复')
        if len(set(self.correct_option_ids)) != len(self.correct_option_ids):
            raise ValueError('正确答案不能重复')
        if not set(self.correct_option_ids).issubset(option_ids):
            raise ValueError('正确答案必须来自本题选项')
        if self.kind == 'single' and len(self.correct_option_ids) != 1:
            raise ValueError('单选题只能有一个正确答案')
        return self


class QuizAnswerInput(StrictModel):
    id: UUID
    selected_option_ids: list[UUID] = Field(min_length=1, max_length=6)

    @field_validator('selected_option_ids')
    @classmethod
    def no_duplicates(cls, value):
        if len(value) != len(set(value)):
            raise ValueError('请勿重复选择同一个选项')
        return value


class MediaInit(StrictModel):
    id: UUID
    draft_id: UUID
    name: str = Field(min_length=1, max_length=255)
    mime: str = Field(default='application/octet-stream', max_length=150)
    size: int = Field(ge=0)

    @field_validator('name')
    @classmethod
    def safe_filename(cls, value):
        import re
        value = re.split(r'[/\\]', value)[-1].strip()
        if not value or value in {'.', '..'} or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError('文件名无效')
        return value


class MediaDiscard(StrictModel):
    draft_id: UUID
