#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
SERVICES=("gateway" "control-plane" "event-collector" "worker")
BUILD_TIMEOUT=300
TEST_TIMEOUT=30

echo "=================================================="
echo "Docker Build Smoke Test"
echo "=================================================="
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

# Function to build a service
build_service() {
    local service=$1
    local dockerfile="apps/${service}/Dockerfile"
    local image_name="stringcost-${service}:smoke-test"

    echo ""
    echo "--------------------------------------------------"
    echo "Building: $service"
    echo "--------------------------------------------------"

    if [ ! -f "$dockerfile" ]; then
        print_status "FAIL" "Dockerfile not found: $dockerfile"
        return 1
    fi

    print_status "INFO" "Starting build for $service..."

    # Build with timeout
    if timeout $BUILD_TIMEOUT docker build \
        -f "$dockerfile" \
        -t "$image_name" \
        . > "/tmp/docker-build-${service}.log" 2>&1; then
        print_status "OK" "Build successful: $service"
        return 0
    else
        print_status "FAIL" "Build failed: $service"
        echo ""
        echo "Last 30 lines of build log:"
        tail -n 30 "/tmp/docker-build-${service}.log"
        return 1
    fi
}

# Function to test if image can start
test_image() {
    local service=$1
    local image_name="stringcost-${service}:smoke-test"
    local port

    case $service in
        gateway)
            port=8787
            ;;
        *)
            port=8080
            ;;
    esac

    echo ""
    print_status "INFO" "Testing container startup for $service..."

    # Start container in background
    local container_id=$(docker run -d \
        --name "smoke-test-${service}" \
        -p "${port}:${port}" \
        "$image_name" 2>&1)

    if [ $? -ne 0 ]; then
        print_status "FAIL" "Failed to start container: $service"
        return 1
    fi

    # Wait for container to start (give it a few seconds)
    sleep 3

    # Check if container is still running
    if docker ps | grep -q "smoke-test-${service}"; then
        print_status "OK" "Container started successfully: $service"

        # Check logs for errors
        local logs=$(docker logs "smoke-test-${service}" 2>&1)
        if echo "$logs" | grep -qi "error"; then
            print_status "FAIL" "Container has errors in logs: $service"
            echo "Container logs:"
            echo "$logs"
            docker stop "smoke-test-${service}" > /dev/null 2>&1
            docker rm "smoke-test-${service}" > /dev/null 2>&1
            return 1
        fi

        # Stop and remove container
        docker stop "smoke-test-${service}" > /dev/null 2>&1
        docker rm "smoke-test-${service}" > /dev/null 2>&1
        return 0
    else
        print_status "FAIL" "Container exited immediately: $service"
        echo "Container logs:"
        docker logs "smoke-test-${service}" 2>&1
        docker rm "smoke-test-${service}" > /dev/null 2>&1
        return 1
    fi
}

# Function to test migrations (only for control-plane)
test_migrations() {
    local service=$1
    local image_name="stringcost-${service}:smoke-test"

    # Only test migrations for control-plane (which runs both control-plane and ledger migrations)
    if [ "$service" != "control-plane" ]; then
        return 0
    fi

    echo ""
    print_status "INFO" "Testing migration commands for $service..."

    # Test that tsx is available
    if docker run --rm "$image_name" which tsx > /dev/null 2>&1; then
        print_status "OK" "tsx is available"
    else
        print_status "FAIL" "tsx not found in image"
        return 1
    fi

    # Test that knex is available
    if docker run --rm "$image_name" sh -c "ls node_modules/.bin/knex" > /dev/null 2>&1; then
        print_status "OK" "knex is available"
    else
        print_status "FAIL" "knex not found in image"
        return 1
    fi

    # Test that migration files exist
    if docker run --rm "$image_name" sh -c "ls apps/control-plane/knex/migrations/*.js" > /dev/null 2>&1; then
        print_status "OK" "control-plane migration files exist"
    else
        print_status "FAIL" "control-plane migration files missing"
        return 1
    fi

    if docker run --rm "$image_name" sh -c "ls apps/ledger/knex/migrations/*.js" > /dev/null 2>&1; then
        print_status "OK" "ledger migration files exist"
    else
        print_status "FAIL" "ledger migration files missing"
        return 1
    fi

    # Test that knexfile.ts exists
    if docker run --rm "$image_name" sh -c "test -f apps/control-plane/knexfile.ts && test -f apps/ledger/knexfile.ts" > /dev/null 2>&1; then
        print_status "OK" "knexfile.ts files exist"
    else
        print_status "FAIL" "knexfile.ts files missing"
        return 1
    fi

    # Test that the migration command can be invoked (dry run - check syntax)
    if docker run --rm "$image_name" sh -c "npm run migrate:control-plane --help 2>&1 | grep -q 'migrate'" > /dev/null 2>&1; then
        print_status "OK" "migration command is valid"
    else
        print_status "FAIL" "migration command failed"
        return 1
    fi

    # Test that src/ directories exist (needed by knexfile.ts imports)
    if docker run --rm "$image_name" sh -c "test -d apps/control-plane/src && test -f apps/control-plane/src/knexConfig.ts" > /dev/null 2>&1; then
        print_status "OK" "control-plane src/ directory exists"
    else
        print_status "FAIL" "control-plane src/ directory or knexConfig.ts missing"
        return 1
    fi

    if docker run --rm "$image_name" sh -c "test -d apps/ledger/src && test -f apps/ledger/src/knexConfig.ts" > /dev/null 2>&1; then
        print_status "OK" "ledger src/ directory exists"
    else
        print_status "FAIL" "ledger src/ directory or knexConfig.ts missing"
        return 1
    fi

    # Test that workspace tsconfig.json files exist (needed by tsx)
    if docker run --rm "$image_name" sh -c "test -f apps/control-plane/tsconfig.json && test -f apps/ledger/tsconfig.json" > /dev/null 2>&1; then
        print_status "OK" "workspace tsconfig.json files exist"
    else
        print_status "FAIL" "workspace tsconfig.json files missing"
        return 1
    fi

    return 0
}

# Function to verify image contents
verify_image_contents() {
    local service=$1
    local image_name="stringcost-${service}:smoke-test"

    print_status "INFO" "Verifying image contents for $service..."

    # Check if essential files exist in the image
    case $service in
        gateway)
            files=(
                "/app/apps/gateway/dist/server.js"
                "/app/apps/shared/dist/index.js"
                "/app/vendor/portkey-gateway/build"
            )
            ;;
        control-plane|event-collector|worker)
            files=(
                "/app/apps/${service}/dist/index.js"
                "/app/apps/shared/dist/index.js"
            )
            if [ "$service" = "worker" ]; then
                files[0]="/app/apps/worker/dist/server.js"
            fi
            ;;
    esac

    local all_exist=true
    for file in "${files[@]}"; do
        if docker run --rm "$image_name" test -e "$file" 2>/dev/null; then
            print_status "OK" "File exists: $file"
        else
            print_status "FAIL" "File missing: $file"
            all_exist=false
        fi
    done

    if [ "$all_exist" = true ]; then
        return 0
    else
        return 1
    fi
}

# Main execution
failed_services=()
successful_services=()

for service in "${SERVICES[@]}"; do
    if build_service "$service"; then
        if verify_image_contents "$service"; then
            if test_migrations "$service"; then
                if test_image "$service"; then
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
    else
        failed_services+=("$service")
    fi
done

# Cleanup
echo ""
echo "=================================================="
echo "Cleanup"
echo "=================================================="
print_status "INFO" "Removing test images..."
for service in "${SERVICES[@]}"; do
    docker rmi "stringcost-${service}:smoke-test" > /dev/null 2>&1 || true
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
