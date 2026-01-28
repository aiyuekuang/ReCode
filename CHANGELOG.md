# Changelog

All notable changes to this project will be documented in this file.

## [0.1.4] - 2026-01-28

### Added
- 🛡️ Protected Files feature - warn or confirm when modifying important config files
- Settings button in sidebar header for quick access to ReCode settings
- New config: `recode.protectedFiles` - glob patterns for protected files
- New config: `recode.protectedFileAction` - action when protected file is modified (none/notify/confirm)

### Changed
- Removed refresh button (auto-refresh is sufficient)

## [0.1.3] - 2026-01-28

### Added
- 🌐 Internationalization (i18n) support - English and Chinese
- Auto language switching based on VS Code language setting

### Fixed
- Fixed codicon icons not displaying in production builds
- Fixed repository URLs in package.json

### Changed
- Added minimum/maximum bounds to debounceDelay and maxHistorySize config
- Updated README with English and Chinese versions

## [0.1.0] - 2024-01-27

### Added
- 🎉 Initial release
- 自动追踪所有代码文件变更
- 一键回滚到任意历史版本
- 批量修改检测（10秒窗口）
- Diff 预览功能
- 恢复功能（撤销回滚）
- 多工作区支持
- 可配置的保留天数和最大记录数
- 自动添加 `.recode` 到 `.gitignore`
- 延迟清理过期记录，避免影响启动性能
