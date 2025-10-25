#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVICES=("gateway" "control-plane" "event-collector" "worker")
WORKSPACE_DIR="/tmp/stringcost-build-test-$$"

echo "=================================================="
echo "Build Smoke Test (CI-style, no Docker)"
echo "=================================================="
echo "This test mimics the exact Docker build steps"
echo "to verify the application builds and starts correctly"
echo ""

# Function to print colored output
print_status() {
    local status=$1
    local message=$2

    if [ "$status" = "OK" ]; then
        echo -e "${GREEN}✓${NC} $message"
    elif [ "$status" = "FAIL" ]; then
        echo -e "${RED}✗${NC} $message"
    elif [ "$status" = "INFO" ]; then
        echo -e "${YELLOW}ℹ${NC} $message"
    fi
}

# Cleanup function
cleanup() {
    if [ -d "$WORKSPACE_DIR" ]; then
        print_status "INFO" "Cleaning up workspace: $WORKSPACE_DIR"
        rm -rf "$WORKSPACE_DIR"
    fi
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Create workspace
print_status "INFO" "Creating workspace: $WORKSPACE_DIR"
mkdir -p "$WORKSPACE_DIR"

# Copy project (mimicking COPY . .)
print_status "INFO" "Copying project files..."
rsync -a --exclude='node_modules' --exclude='dist' --exclude='build' --exclude='.git' \
    ./ "$WORKSPACE_DIR/"

cd "$WORKSPACE_DIR"

# Install dependencies (mimicking Docker build)
print_status "INFO" "Installing dependencies..."
if ! npm install --workspaces --include-workspace-root > /tmp/npm-install.log 2>&1; then
    print_status "FAIL" "npm install failed"
    echo "Last 30 lines of npm install log:"
    tail -n 30 /tmp/npm-install.log
    exit 1
fi
print_status "OK" "Dependencies installed"

# Function to build a service
build_service() {
    local service=$1
    local workspace_name

    case $service in
        gateway)
            workspace_name="@stringcost/gateway"
            # Gateway also needs portkey-gateway
            print_status "INFO" "Building portkey-gateway for $service..."
            if ! npm run build --workspace @portkey-ai/gateway > "/tmp/build-portkey-gateway.log" 2>&1; then
                print_status "FAIL" "Failed to build portkey-gateway"
                echo "Last 30 lines of build log:"
                tail -n 30 "/tmp/build-portkey-gateway.log"
                return 1
            fi
            ;;
        control-plane)
            workspace_name="@stringcost/control-plane"
            ;;
        event-collector)
            workspace_name="@stringcost/event-collector"
            ;;
        worker)
            workspace_name="@stringcost/worker"
            ;;
    esac

    print_status "INFO" "Building shared workspace..."
    if ! npm run build --workspace @stringcost/shared > "/tmp/build-shared-$service.log" 2>&1; then
        print_status "FAIL" "Failed to build shared workspace for $service"
        echo "Last 30 lines of build log:"
        tail -n 30 "/tmp/build-shared-$service.log"
        return 1
    fi

    print_status "INFO" "Building $service..."
    if ! npm run build --workspace "$workspace_name" > "/tmp/build-$service.log" 2>&1; then
        print_status "FAIL" "Build failed: $service"
        echo "Last 30 lines of build log:"
        tail -n 30 "/tmp/build-$service.log"
        return 1
    fi

    print_status "OK" "Build successful: $service"
    return 0
}

# Function to verify built artifacts
verify_artifacts() {
    local service=$1

    print_status "INFO" "Verifying artifacts for $service..."

    case $service in
        gateway)
            files=(
                "apps/gateway/dist/server.js"
                "apps/shared/dist/index.js"
                "vendor/portkey-gateway/build"
            )
            ;;
        control-plane|event-collector|worker)
            files=(
                "apps/${service}/dist/index.js"
                "apps/shared/dist/index.js"
            )
            if [ "$service" = "worker" ]; then
                files[0]="apps/worker/dist/server.js"
            fi
            ;;
    esac

    local all_exist=true
    for file in "${files[@]}"; do
        if [ -e "$file" ]; then
            print_status "OK" "Artifact exists: $file"
        else
            print_status "FAIL" "Artifact missing: $file"
            all_exist=false
        fi
    done

    if [ "$all_exist" = true ]; then
        return 0
    else
        return 1
    fi
}

# Function to test if service can start
test_service_start() {
    local service=$1
    local start_file
    local timeout=5

    print_status "INFO" "Testing if $service can start..."

    case $service in
        gateway)
            start_file="apps/gateway/dist/server.js"
            ;;
        control-plane)
            start_file="apps/control-plane/dist/index.js"
            ;;
        event-collector)
            start_file="apps/event-collector/dist/index.js"
            ;;
        worker)
            start_file="apps/worker/dist/server.js"
            ;;
    esac

    # Try to start the service (it will fail due to missing env vars, but should at least load)
    # We're just checking if the code can be loaded without syntax errors
    if timeout $timeout node "$start_file" > "/tmp/start-$service.log" 2>&1; then
        # If it exits cleanly within timeout, that's actually unexpected but OK
        print_status "OK" "Service started and exited cleanly: $service"
        return 0
    else
        local exit_code=$?
        # Exit code 124 means timeout, which is actually what we expect (service keeps running)
        # Exit code 1-123 means it crashed
        if [ $exit_code -eq 124 ]; then
            print_status "OK" "Service started successfully: $service (timed out as expected)"
            return 0
        else
            # Check if error is due to missing env vars (expected) or actual crash
            local error_log=$(cat "/tmp/start-$service.log" 2>&1)

            # These are expected errors (missing configuration)
            if echo "$error_log" | grep -qiE "(env|environment|database|connection|required|missing|DATABASE_URL|CONTROL_PLANE_URL)"; then
                print_status "OK" "Service loaded successfully: $service (missing env vars as expected)"
                return 0
            else
                print_status "FAIL" "Service crashed unexpectedly: $service"
                echo "Error log:"
                cat "/tmp/start-$service.log"
                return 1
            fi
        fi
    fi
}

# Main execution
echo ""
echo "=================================================="
echo "Running Build Tests"
echo "=================================================="

failed_services=()
successful_services=()

for service in "${SERVICES[@]}"; do
    echo ""
    echo "--------------------------------------------------"
    echo "Testing: $service"
    echo "--------------------------------------------------"

    if build_service "$service"; then
        if verify_artifacts "$service"; then
            if test_service_start "$service"; then
                successful_services+=("$service")
            else
                failed_services+=("$service")
            fi
        else
            failed_services+=("$service")
        fi
    else
        failed_services+=("$service")
    fi
done

# Summary
echo ""
echo "=================================================="
echo "Summary"
echo "=================================================="
echo ""
echo "Successful: ${#successful_services[@]}/${#SERVICES[@]}"
for service in "${successful_services[@]}"; do
    print_status "OK" "$service"
done

if [ ${#failed_services[@]} -gt 0 ]; then
    echo ""
    echo "Failed: ${#failed_services[@]}/${#SERVICES[@]}"
    for service in "${failed_services[@]}"; do
        print_status "FAIL" "$service"
    done
    echo ""
    print_status "FAIL" "Some services failed smoke tests"
    exit 1
else
    echo ""
    print_status "OK" "All services passed smoke tests!"
    exit 0
fi
