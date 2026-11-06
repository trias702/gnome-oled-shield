UUID = oled-care@asplund.kim
EXTENSIONS_PATH = $(HOME)/.local/share/gnome-shell/extensions
DEV_UUID = $(UUID)-dev
BUILD_DIR = build
DIST_DIR = dist
VERSION := $(shell jq -r '.version' metadata.json)

.PHONY: all clean install install-system uninstall package lint test test-unit test-gjs test-integration test-environment test-pixelshift test-setup install-dev uninstall-dev restart-shell test-headless probe-apis watch help dev-setup validate-json build

all: package

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

# Validate JSON files
validate-json:
	@echo "Validating JSON files..."
	@jq '.' metadata.json > /dev/null
	@if command -v xmllint > /dev/null 2>&1; then \
		for schema in schemas/*.xml; do \
			xmllint --noout "$$schema"; \
		done; \
	else \
		echo "Warning: xmllint not found, skipping XML validation"; \
	fi

# Build target that depends on all build steps
build: validate-json
	@echo "Building extension..."
	@mkdir -p $(BUILD_DIR)
	@echo "Compiling schemas..."
	@mkdir -p $(BUILD_DIR)/schemas
	@glib-compile-schemas --strict --targetdir=$(BUILD_DIR)/schemas/ schemas/
	@echo "Copying files..."
	@cp -r \
		extension.js \
		prefs.js \
		metadata.json \
		stylesheet.css \
		README.md \
		lib \
		$(BUILD_DIR)/
	@if [ -f LICENSE ]; then \
		cp LICENSE $(BUILD_DIR)/; \
	fi
	@if [ -d icons ]; then \
		cp -r icons $(BUILD_DIR)/; \
	fi
	@cp -r schemas/*.xml $(BUILD_DIR)/schemas/

# Create distributable package
package: build $(DIST_DIR)
	@echo "Creating package..."
	@cd $(BUILD_DIR) && \
	rm -f ../$(DIST_DIR)/$(UUID)-v$(VERSION).zip && \
	zip -r ../$(DIST_DIR)/$(UUID)-v$(VERSION).zip \
		extension.js \
		prefs.js \
		metadata.json \
		stylesheet.css \
		schemas/ \
		lib/ \
		icons/ \
		README.md \
		$(if $(wildcard LICENSE),LICENSE,)

# Install the extension locally
install: build
	@echo "Installing extension..."
	@rm -rf $(EXTENSIONS_PATH)/$(UUID)
	@mkdir -p $(EXTENSIONS_PATH)/$(UUID)
	@cp -r $(BUILD_DIR)/* $(EXTENSIONS_PATH)/$(UUID)/
	@echo "Extension installed to $(EXTENSIONS_PATH)/$(UUID)"
	@echo "GNOME Shell 50 is Wayland-only: log out and back in so the shell loads the new code,"
	@echo "then enable it with: gnome-extensions enable $(UUID)"

# Install the extension for development
install-dev: build
	@echo "Installing extension for development..."
	@rm -rf $(EXTENSIONS_PATH)/$(DEV_UUID)
	@mkdir -p $(EXTENSIONS_PATH)/$(DEV_UUID)
	@cp -r $(BUILD_DIR)/* $(EXTENSIONS_PATH)/$(DEV_UUID)/
	@sed -i 's/$(UUID)/$(DEV_UUID)/' $(EXTENSIONS_PATH)/$(DEV_UUID)/metadata.json
	@sed -i 's/"development": false/"development": true/' $(EXTENSIONS_PATH)/$(DEV_UUID)/metadata.json
	@mkdir -p $(EXTENSIONS_PATH)/$(DEV_UUID)/schemas
	@cp -f schemas/*.xml $(EXTENSIONS_PATH)/$(DEV_UUID)/schemas/
	@glib-compile-schemas $(EXTENSIONS_PATH)/$(DEV_UUID)/schemas/
	@if [ -d "$(HOME)/.local/share/glib-2.0/schemas" ]; then \
		cp -f schemas/*.xml $(HOME)/.local/share/glib-2.0/schemas/ && \
		glib-compile-schemas $(HOME)/.local/share/glib-2.0/schemas/; \
	fi
	@chmod -R +r $(EXTENSIONS_PATH)/$(DEV_UUID)
	@echo "Development version installed. Log out and back in to load it (GNOME 50 is Wayland-only)."

# System-wide installation
install-system: build
	@echo "Installing system-wide..."
	@sudo mkdir -p /usr/share/gnome-shell/extensions/$(UUID)
	@sudo cp -r $(BUILD_DIR)/* /usr/share/gnome-shell/extensions/$(UUID)/
	@echo "System-wide installation complete."

# Uninstall the extension
uninstall:
	@echo "Uninstalling extension..."
	@rm -rf $(EXTENSIONS_PATH)/$(UUID)
	@echo "Extension uninstalled"

# Uninstall the development version
uninstall-dev:
	@echo "Uninstalling development version..."
	@rm -rf $(EXTENSIONS_PATH)/$(DEV_UUID)
	@echo "Development version uninstalled"

# Run linting checks
lint:
	@echo "Running ESLint..."
	@if command -v eslint >/dev/null 2>&1; then \
		eslint extension.js prefs.js lib/*.js; \
	else \
		echo "ESLint not found. Please install with: npm install -g eslint"; \
		exit 1; \
	fi

# Run all tests
test: validate-json test-gjs test-integration

# Run unit tests with GJS
test-unit:
	@echo "Running unit tests..."
	@gjs -m tests/test-modernization.js
	@for test in tests/unit/*.js tests/unit/lib/*.js; do \
		if [ -f "$$test" ]; then \
			echo "Running $$test..."; \
			gjs -m "$$test"; \
		fi; \
	done

test-gjs:
	@echo "Running GJS tests..."
	@gjs -m tests/test-modernization.js

# Run the extension inside an isolated headless GNOME Shell (see tests/headless/README.md)
test-headless:
	@bash tests/headless/run-headless-tests.sh

# Check that every GNOME Shell/mutter API the extension uses exists on this system
probe-apis:
	@bash tests/headless/probe-shell-apis.sh

test-integration:
	@echo "Running integration tests..."
	@if [ -f tests/run-integration-tests.sh ]; then \
		bash tests/run-integration-tests.sh; \
	else \
		echo "Integration tests not set up yet"; \
	fi

test-environment:
	@echo "Running environment-specific tests..."
	@if [ -f tests/run-environment-tests.sh ]; then \
		bash tests/run-environment-tests.sh; \
	else \
		echo "Setting up environment tests..."; \
		cp tests/run-integration-tests.sh tests/run-environment-tests.sh; \
		sed -i 's/integration/environment/g' tests/run-environment-tests.sh; \
		chmod +x tests/run-environment-tests.sh; \
		bash tests/run-environment-tests.sh; \
	fi

test-pixelshift:
	@echo "Running pixel shift tests..."
	@if command -v jasmine >/dev/null 2>&1; then \
		JASMINE_CONFIG_PATH=tests/pixelshift-jasmine.json jasmine; \
	else \
		echo "Jasmine not found. Please install with: npm install -g jasmine"; \
		exit 1; \
	fi

test-setup:
	@echo "Setting up test environment..."
	@mkdir -p tests/unit
	@mkdir -p tests/integration
	@mkdir -p tests/environment
	@if [ ! -f tests/jasmine.json ]; then \
		echo '{ \
			"spec_dir": "tests", \
			"spec_files": [ \
				"unit/**/*[sS]pec.js", \
				"unit/**/*.test.js", \
				"unit/**/test-*.js" \
			], \
			"helpers": [ \
				"helpers/**/*.js", \
				"unit/mocks/**/*.js" \
			], \
			"stopSpecOnExpectationFailure": false, \
			"random": false \
		}' > tests/jasmine.json; \
	fi
	@if [ ! -f tests/pixelshift-jasmine.json ]; then \
		echo '{ \
			"spec_dir": "tests", \
			"spec_files": [ \
				"test-pixelshift.js" \
			], \
			"helpers": [ \
				"helpers/**/*.js", \
				"testUtils.js" \
			], \
			"stopSpecOnExpectationFailure": false, \
			"random": false \
		}' > tests/pixelshift-jasmine.json; \
	fi
	@if [ ! -f tests/run-integration-tests.sh ]; then \
		echo '#!/bin/bash \
		\necho "Integration tests would run a headless GNOME session and verify extension behavior" \
		\n# Add actual integration test implementation here' > tests/run-integration-tests.sh; \
		chmod +x tests/run-integration-tests.sh; \
	fi
	@if [ ! -f tests/run-environment-tests.sh ]; then \
		echo '#!/bin/bash \
		\necho "Environment tests would simulate different GNOME environments" \
		\n# Add actual environment test implementation here' > tests/run-environment-tests.sh; \
		chmod +x tests/run-environment-tests.sh; \
	fi
	@if [ ! -f tests/unit/example.spec.js ]; then \
		mkdir -p tests/unit; \
		echo "describe('OLED Care Extension', () => { \
		\n  it('should pass a simple test', () => { \
		\n    expect(true).toBe(true); \
		\n  }); \
		\n});" > tests/unit/example.spec.js; \
	fi

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR)
	@rm -rf $(DIST_DIR)

# Development setup
dev-setup: dev-setup-deps install-dev
	@echo "Development environment setup complete"

dev-setup-deps:
	@echo "Setting up development dependencies..."
	@if ! command -v eslint >/dev/null 2>&1; then \
		echo "Installing ESLint..."; \
		npm install -g eslint; \
	fi
	@if ! command -v jq >/dev/null 2>&1; then \
		echo "Please install jq: sudo apt install jq"; \
		exit 1; \
	fi
	@if ! command -v xmllint >/dev/null 2>&1; then \
		echo "Warning: xmllint not found. Install with: sudo apt install libxml2-utils"; \
		echo "XML validation will be skipped during build."; \
	fi

# Watch for changes and rebuild
watch:
	@echo "Watching for changes..."
	@while true; do \
		inotifywait -e modify -r extension.js prefs.js schemas/ metadata.json; \
		make install-dev; \
	done

# GNOME Shell 50 has no X11 session, so the shell cannot be restarted in place
restart-shell:
	@echo "GNOME Shell 50 runs on Wayland only: log out and back in to reload extensions."

# Show help
help:
	@echo "Available targets:"
	@echo "  all              - Default target, same as 'package'"
	@echo "  build            - Build the extension"
	@echo "  package          - Create a distributable zip package"
	@echo "  install          - Install the extension locally"
	@echo "  install-system   - Install the extension system-wide"
	@echo "  install-dev      - Install development version"
	@echo "  uninstall        - Remove the installed extension"
	@echo "  uninstall-dev    - Remove development version"
	@echo "  lint             - Run ESLint on extension.js, prefs.js, and lib/"
	@echo "  test             - Run all tests (GJS + integration)"
	@echo "  test-unit        - Run unit tests with GJS"
	@echo "  test-integration - Run integration tests"
	@echo "  test-headless    - Run in-shell tests in an isolated headless GNOME Shell"
	@echo "  probe-apis       - Check required GNOME Shell/mutter APIs on this system"
	@echo "  test-environment - Run environment-specific tests"
	@echo "  test-pixelshift  - Run pixel shift tests"
	@echo "  test-setup       - Set up test environment"
	@echo "  clean            - Remove build artifacts"
	@echo "  dev-setup        - Set up development environment"
	@echo "  restart-shell    - Explain how to reload the shell on GNOME 50 (Wayland)"
	@echo "  watch            - Watch for changes and rebuild"
	@echo "  validate-json    - Validate JSON and XML schema files"
	@echo "  help             - Show this help message" 